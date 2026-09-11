//! Experiment Monitoring — anomaly detection for training runs.
//!
//! This module implements Phase 3's Experiment Monitoring feature (Section 4 of Phase 3).
//! It detects anomalies in metric time series: loss spikes, NaN values, divergence,
//! and plateaus.
//!
//! ## Anomaly Types
//!
//! - Loss Spike: variance > 3σ or increase > 2x from previous value
//! - NaN Detected: any value is NaN
//! - Divergence: loss increasing for N consecutive steps
//! - Plateau: change < ε for M consecutive steps

use serde::{Deserialize, Serialize};

/// A metric time series point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricPoint {
    pub step: u32,
    pub value: f64,
}

/// Configuration for anomaly detection thresholds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorConfig {
    /// Minimum spike threshold as multiple of standard deviation.
    /// Default: 3.0
    pub spike_std_threshold: f64,
    /// Minimum spike threshold as ratio of previous value.
    /// Default: 2.0 (2x increase)
    /// Set to 0 to disable.
    pub spike_ratio_threshold: f64,
    /// Number of consecutive increasing steps to flag as divergence.
    /// Default: 5
    pub divergence_steps: u32,
    /// Maximum allowed relative change during plateau detection.
    /// Default: 0.001 (0.1%)
    pub plateau_epsilon: f64,
    /// Number of consecutive steps to flag as plateau.
    /// Default: 50
    pub plateau_steps: u32,
    /// Minimum steps before plateau detection starts.
    /// Default: 100
    pub warmup_steps: u32,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            spike_std_threshold: 3.0,
            spike_ratio_threshold: 2.0,
            divergence_steps: 5,
            plateau_epsilon: 0.001,
            plateau_steps: 50,
            warmup_steps: 100,
        }
    }
}

/// Type of anomaly detected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnomalyType {
    LossSpike,
    NanDetected,
    Divergence,
    Plateau,
}

/// Severity level of an anomaly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnomalySeverity {
    Warning,
    Critical,
}

/// An anomaly alert with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnomalyAlert {
    pub anomaly_type: AnomalyType,
    pub severity: AnomalySeverity,
    pub metric: String,
    pub step: u32,
    pub value: f64,
    pub message: String,
}

impl AnomalyAlert {
    pub fn new(
        anomaly_type: AnomalyType,
        metric: &str,
        step: u32,
        value: f64,
        message: &str,
    ) -> Self {
        let severity = match anomaly_type {
            AnomalyType::LossSpike | AnomalyType::Divergence => AnomalySeverity::Critical,
            AnomalyType::NanDetected => AnomalySeverity::Critical,
            AnomalyType::Plateau => AnomalySeverity::Warning,
        };
        Self {
            anomaly_type,
            severity,
            metric: metric.to_string(),
            step,
            value,
            message: message.to_string(),
        }
    }
}

// ── Detection functions ────────────────────────────────────────────────────────

/// Check if a value is NaN.
pub fn is_nan(value: f64) -> bool {
    value.is_nan()
}

/// Calculate mean of a slice.
fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

/// Calculate standard deviation of a slice.
fn std(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let m = mean(values);
    let variance = values.iter().map(|v| (v - m).powi(2)).sum::<f64>() / values.len() as f64;
    variance.sqrt()
}

/// Detect NaN values in a time series.
pub fn detect_nan(series: &[MetricPoint], metric: &str) -> Vec<AnomalyAlert> {
    let mut alerts = Vec::new();

    for point in series {
        if point.value.is_nan() {
            alerts.push(AnomalyAlert::new(
                AnomalyType::NanDetected,
                metric,
                point.step,
                point.value,
                &format!("NaN detected at step {}", point.step),
            ));
        }
    }

    alerts
}

/// Detect loss spikes based on standard deviation and ratio thresholds.
/// A spike is detected if:
/// - The value is more than `std_threshold` standard deviations from the mean, OR
/// - The value is more than `ratio_threshold` times the previous value
pub fn detect_spikes(
    series: &[MetricPoint],
    metric: &str,
    config: &MonitorConfig,
) -> Vec<AnomalyAlert> {
    if series.len() < 10 {
        return Vec::new();
    }

    let mut alerts = Vec::new();
    let values: Vec<f64> = series.iter().map(|p| p.value).collect();

    // Calculate statistics from the window before the spike
    let window_size = (series.len() / 2).min(100);
    let mean_val = mean(&values);
    let std_val = std(&values);

    for (i, point) in series.iter().enumerate().skip(window_size) {
        // Skip if NaN (handled by detect_nan)
        if point.value.is_nan() {
            continue;
        }

        // Check std threshold
        let z_score = if std_val > 0.0 {
            (point.value - mean_val).abs() / std_val
        } else {
            0.0
        };

        let spike_std = z_score > config.spike_std_threshold;

        // Check ratio threshold (compared to previous value)
        let spike_ratio = if i > 0 && values[i - 1] > 0.0 && config.spike_ratio_threshold > 0.0 {
            point.value / values[i - 1] > config.spike_ratio_threshold
        } else {
            false
        };

        if spike_std || spike_ratio {
            let reason = if spike_std && spike_ratio {
                format!(
                    "Spike detected: value={:.4} (z-score={:.2}, ratio={:.2}x)",
                    point.value, z_score, point.value / values[i - 1].max(f64::MIN_POSITIVE)
                )
            } else if spike_std {
                format!(
                    "Spike detected: value={:.4} ({:.2}σ from mean {:.4})",
                    point.value, z_score, mean_val
                )
            } else {
                format!(
                    "Spike detected: value={:.4} ({:.2}x previous value {:.4})",
                    point.value,
                    point.value / values[i - 1].max(f64::MIN_POSITIVE),
                    values[i - 1]
                )
            };

            alerts.push(AnomalyAlert::new(
                AnomalyType::LossSpike,
                metric,
                point.step,
                point.value,
                &reason,
            ));
        }
    }

    alerts
}

/// Detect divergence — loss increasing for N consecutive steps.
pub fn detect_divergence(
    series: &[MetricPoint],
    metric: &str,
    config: &MonitorConfig,
) -> Vec<AnomalyAlert> {
    if series.len() < config.divergence_steps as usize {
        return Vec::new();
    }

    let mut alerts = Vec::new();
    let mut consecutive_increases = 0;
    let mut start_step = 0u32;
    let mut start_value = 0.0f64;

    for (i, point) in series.iter().enumerate() {
        if point.value.is_nan() {
            consecutive_increases = 0;
            continue;
        }

        if i > 0 {
            let prev_value = series[i - 1].value;
            if point.value > prev_value {
                if consecutive_increases == 0 {
                    start_step = series[i - 1].step;
                    start_value = prev_value;
                }
                consecutive_increases += 1;

                if consecutive_increases >= config.divergence_steps {
                    alerts.push(AnomalyAlert::new(
                        AnomalyType::Divergence,
                        metric,
                        point.step,
                        point.value,
                        &format!(
                            "Divergence detected: loss increasing for {} steps (from {:.4} to {:.4})",
                            consecutive_increases, start_value, point.value
                        ),
                    ));
                    // Reset after reporting
                    consecutive_increases = 0;
                }
            } else {
                consecutive_increases = 0;
            }
        }
    }

    alerts
}

/// Detect plateaus — change < ε for M consecutive steps.
pub fn detect_plateau(
    series: &[MetricPoint],
    metric: &str,
    config: &MonitorConfig,
) -> Vec<AnomalyAlert> {
    if series.len() < config.warmup_steps as usize + config.plateau_steps as usize {
        return Vec::new();
    }

    let mut alerts = Vec::new();

    // Start checking after warmup
    let start_idx = config.warmup_steps as usize;
    let window_size = config.plateau_steps as usize;

    // Check if the last `window_size` steps are a plateau
    if series.len() >= start_idx + window_size {
        let plateau_values: Vec<f64> = series[start_idx..]
            .iter()
            .map(|p| p.value)
            .collect();

        let first = plateau_values[0];
        if first <= 0.0 {
            return alerts;
        }

        let mut is_plateau = true;
        let mut max_rel_change = 0.0f64;

        for &v in &plateau_values[1..] {
            let rel_change = ((v - first) / first).abs();
            max_rel_change = max_rel_change.max(rel_change);

            if rel_change > config.plateau_epsilon {
                is_plateau = false;
                break;
            }
        }

        if is_plateau {
            let last = *plateau_values.last().unwrap();
            alerts.push(AnomalyAlert::new(
                AnomalyType::Plateau,
                metric,
                series.last().unwrap().step,
                last,
                &format!(
                    "Plateau detected: loss change < {:.2}% for {} steps (from {:.4} to {:.4})",
                    config.plateau_epsilon * 100.0,
                    window_size,
                    first,
                    last
                ),
            ));
        }
    }

    alerts
}

/// Run all anomaly detectors on a metric time series.
pub fn detect_anomalies(
    series: &[MetricPoint],
    metric: &str,
    config: &MonitorConfig,
) -> Vec<AnomalyAlert> {
    let mut alerts = Vec::new();

    // Run all detectors
    alerts.extend(detect_nan(series, metric));
    alerts.extend(detect_spikes(series, metric, config));
    alerts.extend(detect_divergence(series, metric, config));
    alerts.extend(detect_plateau(series, metric, config));

    // Sort by step
    alerts.sort_by(|a, b| a.step.cmp(&b.step));

    // Remove duplicates (same step, same type)
    alerts.dedup_by(|a, b| a.step == b.step && a.anomaly_type == b.anomaly_type);

    alerts
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_series(values: &[f64]) -> Vec<MetricPoint> {
        values
            .iter()
            .enumerate()
            .map(|(i, &v)| MetricPoint {
                step: (i as u32) * 100,
                value: v,
            })
            .collect()
    }

    #[test]
    fn test_nan_detection() {
        let series = make_series(&[0.5, 0.4, f64::NAN, 0.3, 0.2]);
        let alerts = detect_nan(&series, "loss");
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].step, 200);
    }

    #[test]
    fn test_no_nan() {
        let series = make_series(&[0.5, 0.4, 0.3, 0.2, 0.1]);
        let alerts = detect_nan(&series, "loss");
        assert!(alerts.is_empty());
    }

    #[test]
    fn test_loss_spike_detection() {
        // Need enough points so the spike detector window has data to compare against
        let mut values: Vec<f64> = (0..50).map(|_| 0.5).collect();
        // 3x increase from baseline - should spike
        values.push(1.5);
        let series = make_series(&values);
        let config = MonitorConfig {
            spike_std_threshold: 3.0,
            spike_ratio_threshold: 2.0,
            ..Default::default()
        };
        let alerts = detect_spikes(&series, "loss", &config);
        assert!(!alerts.is_empty(), "Expected spike detection");
        assert_eq!(alerts[0].anomaly_type, AnomalyType::LossSpike);
    }

    #[test]
    fn test_normal_series_no_spikes() {
        let series: Vec<MetricPoint> = (0..50)
            .map(|i| MetricPoint {
                step: i * 100,
                value: 1.0 / (i as f64 + 1.0) + 0.1, // smoothly decreasing
            })
            .collect();
        let alerts = detect_spikes(&series, "loss", &MonitorConfig::default());
        assert!(alerts.is_empty(), "Normal series should have no spikes");
    }

    #[test]
    fn test_divergence_detection() {
        let mut series = make_series(&[0.5, 0.5, 0.5, 0.5, 0.5]);
        // Add 6 consecutive increases
        for i in 0..6 {
            series.push(MetricPoint {
                step: (500 + i) as u32,
                value: 0.5 + (i as f64) * 0.1,
            });
        }

        let config = MonitorConfig {
            divergence_steps: 5,
            ..Default::default()
        };
        let alerts = detect_divergence(&series, "loss", &config);
        assert!(!alerts.is_empty(), "Expected divergence detection");
        assert_eq!(alerts[0].anomaly_type, AnomalyType::Divergence);
    }

    #[test]
    fn test_no_divergence_on_recovery() {
        let series = make_series(&[
            0.5, 0.6, 0.5, 0.6, 0.5, // oscillating but not consistently increasing
        ]);
        let config = MonitorConfig {
            divergence_steps: 5,
            ..Default::default()
        };
        let alerts = detect_divergence(&series, "loss", &config);
        assert!(alerts.is_empty());
    }

    #[test]
    fn test_plateau_detection() {
        let mut series: Vec<MetricPoint> = (0..100)
            .map(|i| MetricPoint {
                step: i * 10,
                value: 0.3 + (i as f64) * 0.001, // slowly decreasing
            })
            .collect();

        // Add 50 steps with very small change (plateau)
        // First plateau value is 0.4, last is 0.400005 (~0.001% total change)
        for i in 0..50 {
            series.push(MetricPoint {
                step: 1000 + i * 10,
                value: 0.4 + (i as f64) * 0.0000001,
            });
        }

        let config = MonitorConfig {
            plateau_epsilon: 0.001,
            plateau_steps: 50,
            warmup_steps: 100,
            ..Default::default()
        };
        let alerts = detect_plateau(&series, "loss", &config);
        assert!(!alerts.is_empty(), "Expected plateau detection");
        assert_eq!(alerts[0].anomaly_type, AnomalyType::Plateau);
    }

    #[test]
    fn test_no_plateau_on_improvement() {
        let series: Vec<MetricPoint> = (0..200)
            .map(|i| MetricPoint {
                step: i * 10,
                value: 0.5 - (i as f64) * 0.001, // steadily decreasing
            })
            .collect();

        let config = MonitorConfig::default();
        let alerts = detect_plateau(&series, "loss", &config);
        assert!(alerts.is_empty(), "Improvement should not be flagged as plateau");
    }

    #[test]
    fn test_empty_series() {
        let alerts = detect_anomalies(&[], "loss", &MonitorConfig::default());
        assert!(alerts.is_empty());
    }

    #[test]
    fn test_short_series() {
        let series = make_series(&[0.5, 0.4, 0.3]);
        let config = MonitorConfig::default();
        let alerts = detect_anomalies(&series, "loss", &config);
        // Should not crash, may have no alerts due to short length
        assert!(alerts.is_empty());
    }

    #[test]
    fn test_anomaly_severity() {
        let nan_alert = AnomalyAlert::new(AnomalyType::NanDetected, "loss", 100, f64::NAN, "test");
        assert_eq!(nan_alert.severity, AnomalySeverity::Critical);

        let plateau_alert = AnomalyAlert::new(AnomalyType::Plateau, "loss", 100, 0.5, "test");
        assert_eq!(plateau_alert.severity, AnomalySeverity::Warning);
    }

    #[test]
    fn test_multiple_anomaly_types() {
        // First a clean baseline, then NaN, then a spike from a fresh baseline
        let mut values: Vec<f64> = (0..50).map(|_| 0.5).collect();
        values.push(f64::NAN);
        values.push(0.5); // resume baseline
        for _ in 0..49 {
            values.push(0.5);
        }
        values.push(2.0); // 4x spike from 0.5

        let series = make_series(&values);
        let alerts = detect_anomalies(&series, "loss", &MonitorConfig::default());

        let types: Vec<_> = alerts.iter().map(|a| a.anomaly_type.clone()).collect();
        assert!(types.contains(&AnomalyType::NanDetected), "Expected NaN detection, got: {:?}", types);
        assert!(types.contains(&AnomalyType::LossSpike), "Expected spike detection, got: {:?}", types);
    }

    #[test]
    fn test_config_defaults() {
        let config = MonitorConfig::default();
        assert_eq!(config.spike_std_threshold, 3.0);
        assert_eq!(config.spike_ratio_threshold, 2.0);
        assert_eq!(config.divergence_steps, 5);
        assert_eq!(config.plateau_epsilon, 0.001);
        assert_eq!(config.plateau_steps, 50);
        assert_eq!(config.warmup_steps, 100);
    }
}
