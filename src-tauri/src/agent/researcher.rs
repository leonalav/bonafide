//! Researcher Mode — arXiv integration for paper search and reading.
//!
//! This module implements Phase 3's Researcher Mode (Section 5.5 of the spec).
//! It provides arXiv API integration for searching papers and fetching metadata.
//!
//! ## arXiv API
//!
//! The arXiv API is a free, public HTTP API. We use the Atom feed format
//! for search results (no API key required). Base URL: https://export.arxiv.org/api/query
//!
//! ## Tool Definitions (per spec Appendix A)
//!
//! - `search_arxiv`: Search arXiv for papers matching a query
//! - `read_paper`: Fetch and summarize a paper's metadata

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// arXiv paper metadata returned by search and fetch operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArxivPaper {
    /// arXiv ID (e.g., "2301.12345")
    pub id: String,
    /// Paper title
    pub title: String,
    /// List of author names
    pub authors: Vec<String>,
    /// Paper abstract
    pub abstract_: String,
    /// Unix timestamp of original publication
    pub published_at: i64,
    /// Unix timestamp of last update
    pub updated_at: i64,
    /// Direct PDF download URL
    pub pdf_url: String,
    /// arXiv categories (e.g., ["cs.LG", "cs.AI"])
    pub categories: Vec<String>,
}

/// Search result with relevance score (when available).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArxivSearchResult {
    pub papers: Vec<ArxivPaper>,
    pub total_results: usize,
    pub start_index: usize,
    pub items_per_page: usize,
}

/// Error types for arXiv operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArxivError {
    NetworkError(String),
    ParseError(String),
    NotFound(String),
    RateLimited,
    InvalidId(String),
}

impl std::fmt::Display for ArxivError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArxivError::NetworkError(msg) => write!(f, "Network error: {}", msg),
            ArxivError::ParseError(msg) => write!(f, "Parse error: {}", msg),
            ArxivError::NotFound(id) => write!(f, "Paper not found: {}", id),
            ArxivError::RateLimited => write!(f, "Rate limited by arXiv API"),
            ArxivError::InvalidId(id) => write!(f, "Invalid arXiv ID: {}", id),
        }
    }
}

impl std::error::Error for ArxivError {}

const ARXIV_API_BASE: &str = "https://export.arxiv.org/api/query";

/// HTTP client configured for arXiv API with appropriate timeouts.
fn http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Bonafide/1.0 (research agent)")
        .build()
        .expect("Failed to create HTTP client")
}

/// Parse an arXiv ID from various formats.
/// Handles:
/// - Raw ID: "2301.12345"
/// - arXiv URL: "https://arxiv.org/abs/2301.12345"
/// - arXiv URL with version: "https://arxiv.org/abs/2301.12345v2"
/// - arXiv PDF URL: "https://arxiv.org/pdf/2301.12345.pdf"
pub fn parse_arxiv_id(input: &str) -> Option<String> {
    let input = input.trim();

    // Already a clean ID
    if input.len() >= 9 && input.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        // Extract ID up to any version suffix
        let id = input.split(|c| c == 'v' || c == '/').next().unwrap_or(input);
        if id.len() >= 9 {
            return Some(id.to_string());
        }
    }

    // URL format - "arxiv.org/" is 10 chars
    if let Some(idx) = input.find("arxiv.org/") {
        let rest = &input[idx + 10..];
        // Skip "abs/" or "pdf/" prefix
        let id_part = rest.strip_prefix("abs/").or_else(|| rest.strip_prefix("pdf/")).unwrap_or(rest);
        // Remove file extension if present
        let id = id_part.trim_end_matches(".pdf").split(|c| c == 'v' || c == '#').next().unwrap_or(id_part);
        if id.len() >= 9 {
            return Some(id.to_string());
        }
    }

    None
}

/// Build a search query URL for the arXiv API.
fn build_search_url(query: &str, max_results: u32, start: usize) -> String {
    let query_encoded = urlencoding::encode(query);
    format!(
        "{}?search_query=all:{}&start={}&max_results={}&sortBy=relevance&sortOrder=descending",
        ARXIV_API_BASE, query_encoded, start, max_results
    )
}

/// Build a fetch-by-ID URL for the arXiv API.
fn build_fetch_url(id: &str) -> String {
    format!("{}?id_list={}", ARXIV_API_BASE, id)
}

/// Parse Unix timestamp from an ISO 8601 date string.
fn parse_timestamp(s: &str) -> i64 {
    // arXiv returns ISO 8601 format: "2024-01-15T12:00:00Z"
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp())
        .unwrap_or(0)
}

/// Search arXiv for papers matching the query.
/// Returns up to `max_results` papers, sorted by relevance.
pub async fn search_arxiv(query: &str, max_results: u32) -> Result<ArxivSearchResult, ArxivError> {
    if query.trim().is_empty() {
        return Err(ArxivError::ParseError("Query cannot be empty".to_string()));
    }

    let max_results = max_results.min(100); // arXiv API limit

    let url = build_search_url(query, max_results, 0);
    let response = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| ArxivError::NetworkError(e.to_string()))?;

    if response.status() == 429 {
        return Err(ArxivError::RateLimited);
    }

    let body = response
        .text()
        .await
        .map_err(|e| ArxivError::NetworkError(e.to_string()))?;

    parse_atom_feed(&body, max_results as usize)
}

/// Fetch a single paper by arXiv ID.
/// Spec name (Appendix A, line 1659): `read_paper`.
/// `read_paper` is an alias for `get_arxiv_paper` so either name
/// can be used to satisfy LLM tool-name expectations.
pub async fn read_paper(id: &str) -> Result<ArxivPaper, ArxivError> {
    get_arxiv_paper(id).await
}

pub async fn get_arxiv_paper(id: &str) -> Result<ArxivPaper, ArxivError> {
    let clean_id = parse_arxiv_id(id)
        .ok_or_else(|| ArxivError::InvalidId(id.to_string()))?;

    let url = build_fetch_url(&clean_id);
    let response = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| ArxivError::NetworkError(e.to_string()))?;

    if response.status() == 404 {
        return Err(ArxivError::NotFound(clean_id));
    }

    if response.status() == 429 {
        return Err(ArxivError::RateLimited);
    }

    let body = response
        .text()
        .await
        .map_err(|e| ArxivError::NetworkError(e.to_string()))?;

    let result = parse_atom_feed(&body, 1)?;

    result.papers.into_iter().next()
        .ok_or_else(|| ArxivError::NotFound(clean_id))
}

/// Parse an Atom feed response from arXiv API.
/// Returns papers along with pagination info.
fn parse_atom_feed(body: &str, _max_results: usize) -> Result<ArxivSearchResult, ArxivError> {
    let mut papers = Vec::new();
    let mut total_results = 0;
    let mut start_index = 0;
    let mut items_per_page = 0;

    // Line-based XML parsing with multiline support. arXiv's Atom
    // feed has each field on its own line, but fields like <title>
    // and <summary> may have content spanning multiple lines.
    let mut current_entry: Option<EntryBuilder> = None;
    let mut in_entry = false;

    // Buffer for accumulating content when an open tag's closing tag
    // hasn't been seen yet (multiline content).
    let mut pending_tag: Option<String> = None;
    let mut pending_content: Option<String> = None;

    for raw_line in body.lines() {
        let line = raw_line.trim();

        // Parse feed-level metadata
        if line.starts_with("<opensearch:totalResults>") {
            if let Some(end) = line.find("</opensearch:totalResults>") {
                total_results = line[25..end].parse().unwrap_or(0);
            }
        }
        if line.starts_with("<opensearch:startIndex>") {
            if let Some(end) = line.find("</opensearch:startIndex>") {
                start_index = line[23..end].parse().unwrap_or(0);
            }
        }
        if line.starts_with("<opensearch:itemsPerPage>") {
            if let Some(end) = line.find("</opensearch:itemsPerPage>") {
                items_per_page = line[24..end].parse().unwrap_or(0);
            }
        }

        // Track entry boundaries
        if line == "<entry>" {
            in_entry = true;
            current_entry = Some(EntryBuilder::default());
            continue;
        }
        if line == "</entry>" {
            // Flush any pending content
            if let (Some(tag), Some(content)) = (pending_tag.take(), pending_content.take()) {
                if let Some(entry) = current_entry.as_mut() {
                    apply_parsed_field(entry, &tag, content);
                }
            }
            if let Some(builder) = current_entry.take() {
                if let Some(paper) = builder.build() {
                    papers.push(paper);
                }
            }
            in_entry = false;
            continue;
        }

        if !in_entry {
            continue;
        }
        let entry = match current_entry.as_mut() {
            Some(e) => e,
            None => continue,
        };

        // Try to extract <tag>content</tag> on a single line
        let mut matched = false;
        for tag_name in &["id", "title", "summary", "published", "updated"] {
            if let Some(content) = extract_tag(line, tag_name) {
                apply_parsed_field(entry, tag_name, content);
                matched = true;
                break;
            }
        }
        if matched {
            pending_tag = None;
            pending_content = None;
            continue;
        }

        // <author><name>...</name></author> — extract inner name
        if line.starts_with("<author><name>") || line.starts_with("<author> <name>") {
            if let Some(end) = line.find("</name>") {
                let after_name_open = line.find("<name>").map(|i| i + 6).unwrap_or(0);
                let name = line[after_name_open..end].to_string();
                entry.authors.push(name);
            }
            continue;
        }

        // <link title="pdf" href="..."/> — extract PDF URL
        if line.starts_with("<link") {
            if let Some(href_start) = line.find("href=\"") {
                let rest = &line[href_start + 6..];
                if let Some(href_end) = rest.find("\"") {
                    entry.pdf_url = Some(rest[..href_end].to_string());
                }
            }
            continue;
        }

        // <category term="..."/> — extract category
        if line.starts_with("<category") {
            if let Some(term_start) = line.find("term=\"") {
                let rest = &line[term_start + 6..];
                if let Some(term_end) = rest.find("\"") {
                    entry.categories.push(rest[..term_end].to_string());
                }
            }
            continue;
        }

        // Handle multiline content for known tags
        if let Some(tag) = &pending_tag {
            // We're accumulating content; check if this line ends with the closing tag
            let closing = format!("</{}>", tag);
            if line.ends_with(&closing) {
                let content_end = line.len() - closing.len();
                let additional = &line[..content_end];
                let combined = format!("{} {}", pending_content.take().unwrap_or_default(), additional);
                apply_parsed_field(entry, tag, normalize_whitespace(&combined));
                pending_tag = None;
                pending_content = None;
            } else {
                // Continue accumulating
                pending_content = Some(format!(
                    "{} {}",
                    pending_content.take().unwrap_or_default(),
                    line
                ));
            }
            continue;
        }

        // Check for an opening tag that may have multiline content
        for tag_name in &["title", "summary", "id", "published", "updated"] {
            let open = format!("<{}>", tag_name);
            if line.starts_with(&open) && !line.contains(&format!("</{}>", tag_name)) {
                // Multiline content begins
                pending_tag = Some(tag_name.to_string());
                let rest = &line[open.len()..];
                pending_content = Some(rest.to_string());
                break;
            }
        }
    }

    Ok(ArxivSearchResult {
        papers,
        total_results,
        start_index,
        items_per_page,
    })
}

/// Apply a parsed field value to the entry builder.
fn apply_parsed_field(entry: &mut EntryBuilder, tag: &str, content: String) {
    match tag {
        "id" => {
            if let Some(id) = parse_arxiv_id(&content) {
                entry.id = Some(id);
            }
        }
        "title" => {
            entry.title = Some(content);
        }
        "summary" => {
            entry.abstract_ = Some(content);
        }
        "published" => {
            entry.published_at = Some(parse_timestamp(&content));
        }
        "updated" => {
            entry.updated_at = Some(parse_timestamp(&content));
        }
        _ => { /* ignore unknown tags */ }
    }
}

/// Extract `<tag>content</tag>` from a single line.
/// Returns `None` if the line doesn't contain this tag with both open and close.
fn extract_tag(line: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);

    let start = line.find(&open)?;
    let content_start = start + open.len();
    let end = line[content_start..].find(&close)?;
    let content = &line[content_start..content_start + end];

    // Only return Some if both open and close are on the same line
    // (otherwise it's a multiline field, handled separately).
    Some(normalize_whitespace(content))
}

/// Normalize whitespace in a string (collapse runs of whitespace into single spaces).
fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Builder for constructing ArxivPaper during parsing.
#[derive(Default)]
struct EntryBuilder {
    id: Option<String>,
    title: Option<String>,
    authors: Vec<String>,
    abstract_: Option<String>,
    published_at: Option<i64>,
    updated_at: Option<i64>,
    pdf_url: Option<String>,
    categories: Vec<String>,
}

impl EntryBuilder {
    fn build(self) -> Option<ArxivPaper> {
        Some(ArxivPaper {
            id: self.id?,
            title: self.title.unwrap_or_default(),
            authors: self.authors,
            abstract_: self.abstract_.unwrap_or_default(),
            published_at: self.published_at.unwrap_or(0),
            updated_at: self.updated_at.unwrap_or(self.published_at.unwrap_or(0)),
            pdf_url: self.pdf_url.unwrap_or_default(),
            categories: self.categories,
        })
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_arxiv_id() {
        // Raw IDs
        assert_eq!(parse_arxiv_id("2301.12345"), Some("2301.12345".to_string()));
        assert_eq!(parse_arxiv_id("2301.12345v2"), Some("2301.12345".to_string()));
        assert_eq!(parse_arxiv_id("2301.12345v10"), Some("2301.12345".to_string()));

        // URL formats
        assert_eq!(
            parse_arxiv_id("https://arxiv.org/abs/2301.12345"),
            Some("2301.12345".to_string())
        );
        assert_eq!(
            parse_arxiv_id("https://arxiv.org/abs/2301.12345v3"),
            Some("2301.12345".to_string())
        );
        assert_eq!(
            parse_arxiv_id("https://arxiv.org/pdf/2301.12345.pdf"),
            Some("2301.12345".to_string())
        );
        assert_eq!(
            parse_arxiv_id("http://arxiv.org/abs/2301.12345"),
            Some("2301.12345".to_string())
        );

        // Invalid
        assert_eq!(parse_arxiv_id(""), None);
        assert_eq!(parse_arxiv_id("invalid"), None);
        assert_eq!(parse_arxiv_id("abc"), None);
    }

    #[test]
    fn test_build_search_url() {
        let url = build_search_url("transformer attention", 10, 0);
        assert!(url.contains("transformer%20attention"));
        assert!(url.contains("max_results=10"));
        assert!(url.contains("sortBy=relevance"));
    }

    #[test]
    fn test_build_fetch_url() {
        let url = build_fetch_url("2301.12345");
        assert!(url.contains("id_list=2301.12345"));
    }

    #[test]
    fn test_parse_timestamp() {
        // RFC 3339 format
        let ts = parse_timestamp("2024-01-15T12:00:00Z");
        assert!(ts > 0);

        // Invalid format should return 0
        let ts_invalid = parse_timestamp("invalid");
        assert_eq!(ts_invalid, 0);
    }

    #[test]
    fn test_parse_atom_feed_minimal() {
        let xml = r#"
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <entry>
    <id>https://arxiv.org/abs/2301.12345</id>
    <title>Test Paper Title</title>
    <summary>This is the abstract.</summary>
    <author><name>John Doe</name></author>
    <author><name>Jane Smith</name></author>
    <published>2024-01-15T12:00:00Z</published>
    <updated>2024-01-16T00:00:00Z</updated>
    <link title="pdf" href="https://arxiv.org/pdf/2301.12345.pdf"/>
    <category term="cs.AI"/>
    <category term="cs.LG"/>
  </entry>
</feed>
"#;

        let result = parse_atom_feed(xml, 10).unwrap();
        assert_eq!(result.total_results, 1);
        assert_eq!(result.papers.len(), 1);

        let paper = &result.papers[0];
        assert_eq!(paper.id, "2301.12345");
        assert_eq!(paper.title, "Test Paper Title");
        assert_eq!(paper.authors, vec!["John Doe", "Jane Smith"]);
        assert_eq!(paper.categories, vec!["cs.AI", "cs.LG"]);
        assert!(paper.pdf_url.contains("2301.12345.pdf"));
    }

    #[test]
    fn test_parse_atom_feed_empty() {
        let xml = r#"
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>0</opensearch:itemsPerPage>
</feed>
"#;

        let result = parse_atom_feed(xml, 10).unwrap();
        assert_eq!(result.total_results, 0);
        assert_eq!(result.papers.len(), 0);
    }

    #[test]
    fn test_parse_atom_feed_multiline_title() {
        // arXiv titles can have newlines
        let xml = r#"
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <entry>
    <id>https://arxiv.org/abs/2301.99999</id>
    <title>
      Attention Is All You Need
    </title>
    <summary>
      The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.
    </summary>
    <published>2024-01-15T12:00:00Z</published>
  </entry>
</feed>
"#;

        let result = parse_atom_feed(xml, 10).unwrap();
        assert_eq!(result.papers.len(), 1);
        assert_eq!(result.papers[0].title, "Attention Is All You Need");
        assert!(result.papers[0].abstract_.starts_with("The dominant"));
    }
}
