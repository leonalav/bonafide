// monitoring.rs — Experiment monitoring and anomaly detection (section 4.6).
//
// Spec contract (section 4.6):
// - NaN detection: any `loss` or `accuracy` that is NaN is an anomaly
// - Loss spike: current loss > 3σ above the rolling mean (last 50 steps)
// - Divergence: current loss > 5× the initial baseline (first 10 steps)
// - Plateau: if the change over the last 100 steps is < 1%, flag it
// - The function signature is `detect_anomalies(run_id: &str) -> Result<Vec<Anomaly>>`
// - A background polling hook (not implemented here) would call this at regular intervals
// - Each anomaly has: type, step, metric_name, metric_value, threshold_violated

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// `Anomaly` — a detected issue in a run's metric stream (section 4.6).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Anomaly {
    pub anomaly_type: AnomalyType,
    pub step: u64,
    pub metric_name: String,
    pub metric_value: f64,
    pub threshold_violated: String,
}

/// `AnomalyType` — the four patterns from section 4.6.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnomalyType {
    Nan,
    LossSpike,
    Divergence,
    Plateau,
}

/// `detect_anomalies` — scans the run's metric history and returns all anomalies.
/// 
/// This is the public API surface called by the tool execution bridge (section 4.6).
/// The actual metric history is queried from the experiment tracker (MLflow, W&B, etc.).
/// For now, we accept a mock metric stream as input so this module can be tested in isolation.
/// A future integration pass (WS5-T2) will wire the real tracker query.
pub fn detect_anomalies(metrics: &[MetricPoint]) -> Vec<Anomaly> {
    let mut anomalies = Vec::new();

    // Group metrics by name so we can compute per-metric statistics.
    let mut grouped: HashMap<String, Vec<&MetricPoint>> = HashMap::new();
    for point in metrics {
        grouped.entry(point.metric_name.clone()).or_default().push(point);
    }

    for (metric_name, points) in grouped {
        // Sort by step so we can compute rolling windows.
        let mut sorted: Vec<_> = points.into_iter().collect();
        sorted.sort_by_key(|p| p.step);

        // NaN check: any point with NaN value is an anomaly.
        for point in &sorted {
            if point.value.is_nan() {
                anomalies.push(Anomaly {
                    anomaly_type: AnomalyType::Nan,
                    step: point.step,
                    metric_name: metric_name.clone(),
                    metric_value: point.value,
                    threshold_violated: "NaN detected".to_string(),
                });
            }
        }

        // Loss spike: current loss > 3σ above rolling mean (last 50 steps).
        // Only apply to metrics named "loss" or "train_loss" or "val_loss".
        if metric_name.contains("loss") {
            for (i, point) in sorted.iter().enumerate() {
                if point.value.is_nan() {
                    continue;
                }
                // Rolling window: last 50 steps (or fewer if we haven't reached 50 yet).
                let window_start = i.saturating_sub(50);
                let window = &sorted[window_start..i];
                if window.len() < 10 {
                    // Not enough history to compute rolling statistics.
                    continue;
                }
                let values: Vec<f64> = window.iter().map(|p| p.value).filter(|v| !v.is_nan()).collect();
                if values.is_empty() {
                    continue;
                }
                let mean = values.iter().sum::<f64>() / values.len() as f64;
                let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
                let std_dev = variance.sqrt();
                let threshold = mean + 3.0 * std_dev;
                if point.value > threshold {
                    anomalies.push(Anomaly {
                        anomaly_type: AnomalyType::LossSpike,
                        step: point.step,
                        metric_name: metric_name.clone(),
                        metric_value: point.value,
                        threshold_violated: format!(">{:.4} (mean+3σ)", threshold),
                    });
                }
            }

            // Divergence: current loss > 5× the initial baseline (first 10 steps).
            let baseline_points: Vec<&MetricPoint> = sorted.iter().take(10).filter(|p| !p.value.is_nan()).copied().collect();
            if !baseline_points.is_empty() {
                let baseline_mean = baseline_points.iter().map(|p| p.value).sum::<f64>() / baseline_points.len() as f64;
                let divergence_threshold = baseline_mean * 5.0;
                for point in sorted.iter().skip(10) {
                    if point.value.is_nan() {
                        continue;
                    }
                    if point.value > divergence_threshold {
                        anomalies.push(Anomaly {
                            anomaly_type: AnomalyType::Divergence,
                            step: point.step,
                            metric_name: metric_name.clone(),
                            metric_value: point.value,
                            threshold_violated: format!(">{:.4} (5× baseline)", divergence_threshold),
                        });
                    }
                }
            }
        }

        // Plateau: if the change over the last 100 steps is < 1%, flag it.
        // Apply to all metrics (not just loss).
        if sorted.len() >= 100 {
            let recent_window = &sorted[sorted.len() - 100..];
            let values: Vec<f64> = recent_window.iter().map(|p| p.value).filter(|v| !v.is_nan()).collect();
            if values.len() >= 100 {
                let first = values[0];
                let last = values[values.len() - 1];
                let change_pct = ((last - first).abs() / first.abs()) * 100.0;
                if change_pct < 1.0 {
                    anomalies.push(Anomaly {
                        anomaly_type: AnomalyType::Plateau,
                        step: sorted[sorted.len() - 1].step,
                        metric_name: metric_name.clone(),
                        metric_value: last,
                        threshold_violated: format!("<1% change over 100 steps ({:.2}%)", change_pct),
                    });
                }
            }
        }
    }

    anomalies
}

/// `MetricPoint` — a single timestep in a metric stream.
/// This is the input format for `detect_anomalies`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetricPoint {
    pub step: u64,
    pub metric_name: String,
    pub value: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `detect_anomalies_nan_detection`: a NaN value is always flagged.
    #[test]
    fn detect_anomalies_nan_detection() {
        let metrics = vec![
            MetricPoint { step: 0, metric_name: "loss".to_string(), value: 1.0 },
            MetricPoint { step: 1, metric_name: "loss".to_string(), value: f64::NAN },
            MetricPoint { step: 2, metric_name: "loss".to_string(), value: 0.9 },
        ];
        let anomalies = detect_anomalies(&metrics);
        assert_eq!(anomalies.len(), 1);
        assert_eq!(anomalies[0].anomaly_type, AnomalyType::Nan);
        assert_eq!(anomalies[0].step, 1);
        assert_eq!(anomalies[0].metric_name, "loss");
    }

    /// `detect_anomalies_loss_spike_triggers_at_3_sigma`: a sudden spike
    /// beyond 3σ above the rolling mean is flagged.
    #[test]
    fn detect_anomalies_loss_spike_triggers_at_3_sigma() {
        // Build 60 points with stable loss around 1.0, then a spike at step 60.
        let mut metrics = Vec::new();
        for step in 0..60 {
            metrics.push(MetricPoint { step, metric_name: "loss".to_string(), value: 1.0 });
        }
        // Spike: mean=1.0, std_dev≈0 (all values are the same), threshold≈1.0.
        // A value of 10.0 is definitely >1.0+3*0, so it will trigger.
        metrics.push(MetricPoint { step: 60, metric_name: "loss".to_string(), value: 10.0 });

        let anomalies = detect_anomalies(&metrics);
        let spikes: Vec<_> = anomalies.iter().filter(|a| a.anomaly_type == AnomalyType::LossSpike).collect();
        assert!(!spikes.is_empty(), "expected at least one loss spike");
        assert_eq!(spikes[0].step, 60);
    }

    /// `detect_anomalies_divergence_triggers_at_5x_baseline`: if the loss
    /// exceeds 5× the baseline (mean of first 10 steps), it's a divergence.
    #[test]
    fn detect_anomalies_divergence_triggers_at_5x_baseline() {
        let mut metrics = Vec::new();
        // Baseline: first 10 steps at 1.0 → baseline_mean = 1.0.
        for step in 0..10 {
            metrics.push(MetricPoint { step, metric_name: "train_loss".to_string(), value: 1.0 });
        }
        // Divergence: step 20 at 6.0 > 5.0 threshold.
        for step in 10..20 {
            metrics.push(MetricPoint { step, metric_name: "train_loss".to_string(), value: 1.5 });
        }
        metrics.push(MetricPoint { step: 20, metric_name: "train_loss".to_string(), value: 6.0 });

        let anomalies = detect_anomalies(&metrics);
        let divergences: Vec<_> = anomalies.iter().filter(|a| a.anomaly_type == AnomalyType::Divergence).collect();
        assert!(!divergences.is_empty(), "expected at least one divergence");
        assert_eq!(divergences[0].step, 20);
        assert_eq!(divergences[0].metric_value, 6.0);
    }

    /// `detect_anomalies_plateau_triggers_at_1_percent_change`: if the
    /// metric doesn't change by at least 1% over 100 steps, it's a plateau.
    #[test]
    fn detect_anomalies_plateau_triggers_at_1_percent_change() {
        let mut metrics = Vec::new();
        // 100 steps with loss oscillating between 1.0 and 1.005 (< 1% change).
        for step in 0..100 {
            let value = if step % 2 == 0 { 1.0 } else { 1.005 };
            metrics.push(MetricPoint { step, metric_name: "val_loss".to_string(), value });
        }

        let anomalies = detect_anomalies(&metrics);
        let plateaus: Vec<_> = anomalies.iter().filter(|a| a.anomaly_type == AnomalyType::Plateau).collect();
        assert!(!plateaus.is_empty(), "expected at least one plateau");
        assert_eq!(plateaus[0].step, 99);
    }

    /// `detect_anomalies_no_false_positives_on_healthy_run`: a well-behaved
    /// metric stream (smooth decay, no spikes, no NaNs) should produce zero anomalies.
    #[test]
    fn detect_anomalies_no_false_positives_on_healthy_run() {
        let mut metrics = Vec::new();
        // 200 steps with exponential decay from 2.0 to 0.2 (smooth, no issues).
        for step in 0..200 {
            let value = 2.0 * (-0.01 * step as f64).exp();
            metrics.push(MetricPoint { step, metric_name: "loss".to_string(), value });
        }

        let anomalies = detect_anomalies(&metrics);
        assert!(anomalies.is_empty(), "expected zero anomalies on a healthy run, got {:?}", anomalies);
    }

    /// `detect_anomalies_multiple_metrics_isolated`: anomalies in one metric
    /// don't leak into another metric's detection.
    #[test]
    fn detect_anomalies_multiple_metrics_isolated() {
        let mut metrics = Vec::new();
        // Loss: stable, no issues.
        for step in 0..100 {
            metrics.push(MetricPoint { step, metric_name: "loss".to_string(), value: 1.0 });
        }
        // Accuracy: has a NaN at step 50.
        for step in 0..100 {
            let value = if step == 50 { f64::NAN } else { 0.9 };
            metrics.push(MetricPoint { step, metric_name: "accuracy".to_string(), value });
        }

        let anomalies = detect_anomalies(&metrics);
        assert_eq!(anomalies.len(), 1);
        assert_eq!(anomalies[0].anomaly_type, AnomalyType::Nan);
        assert_eq!(anomalies[0].metric_name, "accuracy");
        assert_eq!(anomalies[0].step, 50);
    }

    /// `detect_anomalies_empty_input`: calling with an empty metric stream
    /// returns an empty anomaly list (no panics, no errors).
    #[test]
    fn detect_anomalies_empty_input() {
        let anomalies = detect_anomalies(&[]);
        assert!(anomalies.is_empty());
    }

    /// `detect_anomalies_all_nan_input`: if every metric value is NaN, we
    /// get one NaN anomaly per point, but no spike/divergence/plateau
    /// (those require valid values to compute statistics).
    #[test]
    fn detect_anomalies_all_nan_input() {
        let metrics = vec![
            MetricPoint { step: 0, metric_name: "loss".to_string(), value: f64::NAN },
            MetricPoint { step: 1, metric_name: "loss".to_string(), value: f64::NAN },
            MetricPoint { step: 2, metric_name: "loss".to_string(), value: f64::NAN },
        ];
        let anomalies = detect_anomalies(&metrics);
        assert_eq!(anomalies.len(), 3);
        assert!(anomalies.iter().all(|a| a.anomaly_type == AnomalyType::Nan));
    }
}

// ── Async helper for Tauri IPC command ────────────────────────────────────────
//
// `detect_anomalies_for_run` fetches metric series from the tracker provider
// and runs `detect_anomalies`. It is async so it can await the tracker
// provider's HTTP calls. The Tauri command wraps it in `block_in_place`.

/// Fetch all available metric series for `run_id` from whichever tracker
/// is connected for `workspace_hash`, then run `detect_anomalies`.
pub async fn detect_anomalies_for_run(
    workspace_hash: &str,
    run_id: &str,
) -> Vec<Anomaly> {
    use crate::tracker::wandb::Point as WbPoint;

    let common_keys = ["loss", "train_loss", "val_loss", "accuracy", "val_accuracy"];

    // Collect metrics from whichever tracker is available.
    let mut all_points: Vec<MetricPoint> = Vec::new();

    // W&B path
    if let Some(provider) = crate::tracker::wandb::get_wandb_provider(workspace_hash).await {
        for key in &common_keys {
            match provider.get_metric_series(run_id, key).await {
                Ok(points) => {
                    for WbPoint { step, value, .. } in points {
                        all_points.push(MetricPoint {
                            step: step as u64,
                            metric_name: key.to_string(),
                            value,
                        });
                    }
                }
                Err(_) => { /* metric not present for this run — skip */ }
            }
        }
    }

    // MLflow path (re-uses wandb::Point via re-export)
    if let Some(provider) = crate::tracker::mlflow::get_mlflow_provider(workspace_hash).await {
        for key in &common_keys {
            match provider.get_metric_series(run_id, key).await {
                Ok(points) => {
                    for WbPoint { step, value, .. } in points {
                        all_points.push(MetricPoint {
                            step: step as u64,
                            metric_name: key.to_string(),
                            value,
                        });
                    }
                }
                Err(_) => { /* metric not present for this run — skip */ }
            }
        }
    }

    detect_anomalies(&all_points)
}
