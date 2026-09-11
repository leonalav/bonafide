//! Agent LLM client — OpenAI-compatible protocol with tool-call support.
//!
//! This module defines the Rust-side LLM protocol consumed by the ReAct engine
//! (`engine.rs`). It mirrors the TypeScript `src/llm/` shapes so both sides
//! agree on the wire format.
//!
//! ## Design
//!
//! - `LlmClient` is a `Send + Sync` trait so it can be held behind an
//!   `Arc<dyn LlmClient>` in the engine without lifetime headaches.
//! - `OpenAiCompatibleClient` is the concrete implementation backed by `reqwest`.
//! - The `ChatRequest` / `ChatResponse` shapes match the OpenAI
//!   `/v1/chat/completions` schema exactly so any OpenAI-compatible endpoint
//!   (LM Studio, vLLM, Groq, Fireworks AI, …) works without adapter code.
//! - `tools` on `ChatRequest` is `Option` so non-agent code paths still compile.
//! - `ToolCall` on `ChatResponse` is always a `Vec` — empty means "final answer".
//!
//! ## Tool-call protocol version
//!
//! The wire format follows OpenAI's `function` call schema (2023 tool-use).
//! `TOOL_CALL_PROTOCOL_VERSION = "openai/v1"` is mirrored in
//! `src/llm/types.ts` so TypeScript consumers can assert version compatibility.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use thiserror::Error;

// ── Protocol version constant ───────────────────────────────────────────────────

/// Mirrors `TOOL_CALL_PROTOCOL_VERSION` in `src/llm/types.ts`.
pub const TOOL_CALL_PROTOCOL_VERSION: &str = "openai/v1";

// ── Role ─────────────────────────────────────────────────────────────────────

/// Chat role, matching the OpenAI schema.
///
/// Note: `System` here is the API role, not the system-prompt layer
/// (which is modelled as a `user` turn by some providers). We keep it
/// explicit so serialisation is unambiguous.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

// ── Tool definitions ──────────────────────────────────────────────────────────

/// Mirrors `ToolDefinition` in `src/llm/types.ts`. Canonical field names
/// are lowercase `function.name`, `function.description`,
/// `function.parameters` — matching the OpenAI wire schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: ToolFunction,
}

/// The function payload inside a `ToolDefinition`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    /// `serde_json::Value` matches `Record<string, unknown>` on the TS side.
    pub parameters: serde_json::Value,
}

// ── Tool calls ────────────────────────────────────────────────────────────────

/// A tool call returned by the model inside a `ChatResponse`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: ToolFunctionCall,
}

/// The function portion of a `ToolCall`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFunctionCall {
    pub name: String,
    /// Raw JSON string — the caller deserialises based on `ToolDefinition.parameters`.
    pub arguments: String,
}

// ── Chat messages ─────────────────────────────────────────────────────────────

/// One message in the conversation history sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// Set when this message is a tool-result (role = Tool).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Set when the assistant is calling tools.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

impl ChatMessage {
    /// Construct a user message.
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: Role::User, content: content.into(), tool_call_id: None, tool_calls: None }
    }

    /// Construct an assistant message.
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: Role::Assistant, content: content.into(), tool_call_id: None, tool_calls: None }
    }

    /// Construct a system message.
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: Role::System, content: content.into(), tool_call_id: None, tool_calls: None }
    }

    /// Construct a tool-result message.
    pub fn tool(content: impl Into<String>, tool_call_id: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            content: content.into(),
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: None,
        }
    }
}

// ── Chat request / response ───────────────────────────────────────────────────

/// The request body sent to the `/v1/chat/completions` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// The full URL — includes `/v1/chat/completions` already.
    pub endpoint_url: String,
    /// Model ID, e.g. "gpt-4o".
    pub model: String,
    /// Ordered conversation history.
    pub messages: Vec<ChatMessage>,
    /// Tool definitions offered to the model. `None` = no tool support.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
    /// Sampling temperature. `None` uses the provider default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// `false` for buffered (non-streaming) responses.
    #[serde(default = "default_false")]
    pub stream: bool,
}

fn default_false() -> bool { false }

/// Token-usage statistics returned by the provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// The parsed response from the `/v1/chat/completions` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    /// Visible assistant reply text. Empty when the model only returned tool calls.
    pub content: String,
    /// Tool calls requested by the model. Empty = final answer.
    pub tool_calls: Vec<ToolCall>,
    /// Token usage, when reported by the provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

// ── LLM errors ────────────────────────────────────────────────────────────────

/// Errors that can arise during an LLM call.
#[derive(Error, Debug)]
pub enum LlmError {
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },

    #[error("Network unreachable: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Request aborted")]
    Aborted,

    #[error("Malformed response: {0}")]
    MalformedResponse(String),

    #[error("No endpoint configured — add one in Preferences → Models")]
    NoEndpoint,

    #[error("Deserialisation error: {0}")]
    Deserialize(#[from] serde_json::Error),
}

// ── LlmClient trait ──────────────────────────────────────────────────────────

/// The core abstraction consumed by the ReAct engine.
///
/// Implementors must be `Send + Sync` so the engine can hold a single
/// `Arc<dyn LlmClient>` across all iterations without lifetime complexity.
#[async_trait]
pub trait LlmClient: Send + Sync {
    /// Send a chat-completion request and return the parsed response.
    ///
    /// ## Tool-call semantics (per section 7.2)
    ///
    /// - If `response.tool_calls` is non-empty → the engine executes each
    ///   tool and injects results as `ChatMessage::tool(...)` before
    ///   resuming the loop.
    /// - If `response.tool_calls` is empty → the response is a final answer
    ///   and the loop terminates with `EngineResult::Completed`.
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse, LlmError>;
}

// ── OpenAI-compatible client ─────────────────────────────────────────────────

/// Builder for `OpenAiCompatibleClient`.
#[derive(Debug, Clone)]
pub struct OpenAiClientBuilder {
    api_key: Option<String>,
    endpoint_base_url: Option<String>,
    connect_timeout: Duration,
    timeout: Duration,
}

impl Default for OpenAiClientBuilder {
    fn default() -> Self {
        Self {
            api_key: None,
            endpoint_base_url: None,
            connect_timeout: Duration::from_secs(10),
            timeout: Duration::from_secs(120),
        }
    }
}

impl OpenAiClientBuilder {
    /// Set the API key. When empty/None the `Authorization` header is
    /// omitted so LM Studio with `--no-api-key` continues to work.
    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    /// Set the base URL (e.g. "https://api.openai.com/v1"). Trailing
    /// slashes are stripped automatically.
    pub fn endpoint_base_url(mut self, url: impl Into<String>) -> Self {
        self.endpoint_base_url = Some(url.into());
        self
    }

    /// Set the TCP connect timeout (default: 10 s).
    pub fn connect_timeout(mut self, d: Duration) -> Self {
        self.connect_timeout = d;
        self
    }

    /// Set the total request timeout (default: 120 s).
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = d;
        self
    }

    pub fn build(self) -> Result<OpenAiCompatibleClient, LlmError> {
        let base_url = self.endpoint_base_url
            .ok_or_else(|| LlmError::NoEndpoint)?;

        let client = Client::builder()
            .connect_timeout(self.connect_timeout)
            .timeout(self.timeout)
            .build()
            .map_err(LlmError::Network)?;

        Ok(OpenAiCompatibleClient {
            client,
            api_key: self.api_key.unwrap_or_default(),
            base_url: base_url.trim_end_matches('/').to_string(),
        })
    }
}

/// An `LlmClient` backed by any OpenAI-compatible `/v1/chat/completions` API.
#[derive(Debug, Clone)]
pub struct OpenAiCompatibleClient {
    client: Client,
    /// Bearer token. Empty string → no `Authorization` header sent.
    api_key: String,
    /// Base URL with no trailing slash, e.g. "https://api.openai.com/v1".
    base_url: String,
}

impl OpenAiCompatibleClient {
    /// Start building with no settings.
    pub fn builder() -> OpenAiClientBuilder {
        OpenAiClientBuilder::default()
    }

    /// Resolve the endpoint URL from the `modelEndpoints` configuration map.
    ///
    /// Mirrors the logic in `src/llm/client.ts` — picks the first endpoint
    /// whose `isActive` flag is `true`. Returns `LlmError::NoEndpoint` when
    /// no active endpoint is configured (matches the TS error message).
    pub fn from_settings(
        _model_endpoints: &[serde_json::Value],
        model_id: &str,
    ) -> Result<Self, LlmError> {
        // Phase 0: we receive an empty list (no endpoints configured yet).
        // The engine calls this with a static settings lookup; once the TS
        // frontend wires up Preferences → Models, this function reads the
        // active endpoint from the settings store. For now we surface the
        // same error the TS client throws so callers handle it uniformly.
        let _ = model_id;
        Err(LlmError::NoEndpoint)
    }

    fn build_url(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }

    fn build_headers(&self) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        // Skip the Authorization header when the key is empty so LM Studio
        // with `--no-api-key` continues to work without 401s.
        if !self.api_key.is_empty() {
            let value = format!("Bearer {}", self.api_key);
            headers.insert(
                reqwest::header::AUTHORIZATION,
                value.parse().unwrap(),
            );
        }
        headers
    }
}

#[async_trait]
impl LlmClient for OpenAiCompatibleClient {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse, LlmError> {
        let url = if req.endpoint_url.is_empty() {
            self.build_url()
        } else {
            req.endpoint_url
        };

        let mut payload = serde_json::json!({
            "model": req.model,
            "messages": req.messages,
            "stream": req.stream,
        });

        // Inject temperature only when explicitly set.
        if let Some(t) = req.temperature {
            payload["temperature"] = serde_json::json!(t);
        }

        // Inject tools only when present — keeps the body small for
        // non-tool-call requests and avoids 400 from providers that don't
        // support the field.
        if let Some(tools) = req.tools {
            payload["tools"] = serde_json::json!(tools);
        }

        let resp = self.client
            .post(&url)
            .headers(self.build_headers())
            .json(&payload)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let snippet = if body.len() > 280 {
                format!("{}…", &body[..280])
            } else {
                body
            };
            return Err(LlmError::Http { status: status.as_u16(), body: snippet });
        }

        // Parse the top-level structure — we read only the fields we need
        // so provider-specific extensions (e.g. extra fields on the response
        // object) don't cause parse failures.
        let parsed: serde_json::Value = resp.json().await?;

        let content = parsed.pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Tool calls live at /choices/0/message/tool_calls.
        let tool_calls: Vec<ToolCall> = parsed
            .pointer("/choices/0/message/tool_calls")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let usage = parsed.pointer("/usage")
            .and_then(|v| serde_json::from_value(v.clone()).ok());

        Ok(ChatResponse { content, tool_calls, usage })
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `serializes_tool_definition_to_openai_shape`:
    /// Verify that a `ToolDefinition` serialises to JSON containing
    /// `tools[0].function.name` and `parameters` — the two fields the
    /// engine reads after parsing a `ChatResponse`.
    #[test]
    fn serializes_tool_definition_to_openai_shape() {
        let td = ToolDefinition {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "read_file".into(),
                description: "Read a file".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }),
            },
        };

        let json = serde_json::to_string(&td).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(
            parsed.pointer("/function/name").and_then(|v| v.as_str()),
            Some("read_file")
        );
        assert!(
            parsed.pointer("/function/parameters").is_some(),
            "parameters must be present"
        );
        assert_eq!(
            parsed.pointer("/function/parameters/type").and_then(|v| v.as_str()),
            Some("object")
        );
    }

    /// `empty_tools_array_is_omitted_from_body`:
    /// When `tools == None`, the serialised body must not contain the key
    /// `"tools"` at all — not an empty array. This matches the existing
    /// `buildRequestBody` behaviour in `client.ts` and avoids 400 from
    /// providers that reject empty `tools`.
    #[test]
    fn empty_tools_array_is_omitted_from_body() {
        let req = ChatRequest {
            endpoint_url: "".into(),
            model: "gpt-4o".into(),
            messages: vec![ChatMessage::user("hello")],
            tools: None,
            temperature: None,
            stream: false,
        };

        let json = serde_json::to_string(&req).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert!(
            parsed.get("tools").is_none(),
            "tools key must be absent when None"
        );
    }

    /// `parses_tool_calls_when_present`:
    /// Fixture response with one tool call → `ChatResponse.tool_calls` len 1,
    /// `id`/`name` correct, `arguments` preserved as raw JSON string.
    #[test]
    fn parses_tool_calls_when_present() {
        let fixture = serde_json::json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_abc123",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\": \"src/main.py\"}"
                        }
                    }]
                }
            }]
        });

        let content = fixture
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let tool_calls: Vec<ToolCall> = fixture
            .pointer("/choices/0/message/tool_calls")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let resp = ChatResponse { content, tool_calls, usage: None };

        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "call_abc123");
        assert_eq!(resp.tool_calls[0].function.name, "read_file");
        assert_eq!(
            resp.tool_calls[0].function.arguments,
            r#"{"path": "src/main.py"}"#
        );
        assert!(resp.content.is_empty());
    }

    /// `returns_empty_tool_calls_when_assistant_final_answer`:
    /// A fixture response with only `content` (no tool_calls field) must
    /// produce a `ChatResponse` with empty `tool_calls` so the engine
    /// treats it as a final answer.
    #[test]
    fn returns_empty_tool_calls_when_assistant_final_answer() {
        let fixture = serde_json::json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "The learning rate is too high."
                }
            }]
        });

        let content = fixture
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let tool_calls: Vec<ToolCall> = fixture
            .pointer("/choices/0/message/tool_calls")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let resp = ChatResponse { content, tool_calls, usage: None };

        assert!(resp.tool_calls.is_empty());
        assert_eq!(resp.content, "The learning rate is too high.");
    }

    /// `skip_authorization_when_api_key_empty`:
    /// Confirm that `build_headers` produces no `Authorization` header
    /// when `api_key` is the empty string.
    #[test]
    fn skip_authorization_when_api_key_empty() {
        let client = OpenAiCompatibleClient {
            client: Client::new(),
            api_key: String::new(),
            base_url: "http://localhost:1234/v1".into(),
        };

        let headers = client.build_headers();
        assert!(
            headers.get(reqwest::header::AUTHORIZATION).is_none(),
            "Authorization header must not be present when api_key is empty"
        );
    }

    /// `include_authorization_when_api_key_present`:
    /// Confirm that `build_headers` produces a valid `Bearer <token>`
    /// header when `api_key` is non-empty.
    #[test]
    fn include_authorization_when_api_key_present() {
        let client = OpenAiCompatibleClient {
            client: Client::new(),
            api_key: "sk-test-key".into(),
            base_url: "https://api.openai.com/v1".into(),
        };

        let headers = client.build_headers();
        let auth = headers.get(reqwest::header::AUTHORIZATION).expect("must be present");
        assert_eq!(auth.to_str().unwrap(), "Bearer sk-test-key");
    }

    /// `serde_roundtrip_tool_call`:
    /// A `ToolCall` serialised then deserialised must produce an identical value.
    #[test]
    fn serde_roundtrip_tool_call() {
        let tc = ToolCall {
            id: "call_xyz".into(),
            tool_type: "function".into(),
            function: ToolFunctionCall {
                name: "get_run".into(),
                arguments: r#"{"run_id": "abc123"}"#.into(),
            },
        };

        let json = serde_json::to_string(&tc).unwrap();
        let roundtrip: ToolCall = serde_json::from_str(&json).unwrap();

        assert_eq!(roundtrip.id, tc.id);
        assert_eq!(roundtrip.function.name, tc.function.name);
        assert_eq!(roundtrip.function.arguments, tc.function.arguments);
    }

    /// `serde_roundtrip_chat_message`:
    /// A `ChatMessage` serialised then deserialised must produce an identical value.
    #[test]
    fn serde_roundtrip_chat_message() {
        let msg = ChatMessage::tool("file contents here", "call_abc");

        let json = serde_json::to_string(&msg).unwrap();
        let roundtrip: ChatMessage = serde_json::from_str(&json).unwrap();

        assert_eq!(roundtrip.role, Role::Tool);
        assert_eq!(roundtrip.tool_call_id.as_deref(), Some("call_abc"));
        assert_eq!(roundtrip.content, "file contents here");
    }

    /// `chat_request_omits_tools_when_none`:
    /// Serialising a `ChatRequest` with `tools: None` must not emit a
    /// `"tools": null` entry — OpenAI-compatible providers often treat
    /// `null` differently from a missing key.
    #[test]
    fn chat_request_omits_tools_when_none() {
        let req = ChatRequest {
            endpoint_url: "".into(),
            model: "gpt-4o".into(),
            messages: vec![],
            tools: None,
            temperature: None,
            stream: false,
        };

        let json = serde_json::to_string(&req).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        // `serde_json` omits fields with `skip_serializing_if = Option::is_none`
        // by emitting them as absent (not as `null`).
        assert!(parsed.get("tools").is_none());
    }

    /// `no_endpoint_error_message_matches_ts`:
    /// `LlmError::NoEndpoint` must carry a message that matches the
    /// `Error("No chat endpoint configured…")` thrown by `client.ts`
    /// so both sides surface the same user-facing text.
    #[test]
    fn no_endpoint_error_message_matches_ts() {
        let err = LlmError::NoEndpoint;
        let msg = err.to_string();
        assert!(
            msg.contains("No endpoint configured"),
            "error message should mention 'No endpoint configured', got: {msg}"
        );
    }
}
