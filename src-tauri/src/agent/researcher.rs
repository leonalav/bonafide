// researcher.rs — arXiv integration for research paper search and retrieval (section 4.8).
//
// Spec contract (section 4.8):
// - `search_arxiv(query: &str, max_results: u32) -> Result<Vec<ArxivPaper>>`
// - `read_paper(arxiv_id: &str) -> Result<ArxivPaper>`
// - Atom feed parsing from `http://export.arxiv.org/api/query`
// - Each paper has: id, title, authors, summary, published, pdf_url

use serde::{Deserialize, Serialize};
use std::error::Error;

/// `ArxivPaper` — metadata for a single arXiv paper (section 4.8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArxivPaper {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub summary: String,
    pub published: String,  // ISO 8601 date string
    pub pdf_url: String,
}

/// `search_arxiv` — queries the arXiv API and returns up to `max_results` papers.
/// 
/// The arXiv API uses Atom feeds. Example query:
/// `http://export.arxiv.org/api/query?search_query=all:neural+networks&max_results=10`
/// 
/// This function is a stub that returns mock data for now. A future integration
/// pass (WS5-T2) will wire the real HTTP client and XML parser.
pub fn search_arxiv(query: &str, max_results: u32) -> Result<Vec<ArxivPaper>, Box<dyn Error>> {
    // TODO: Implement real HTTP request to arXiv API.
    // For now, return mock data so the function signature and types are correct.
    
    if query.is_empty() {
        return Err("query cannot be empty".into());
    }
    
    if max_results == 0 {
        return Ok(Vec::new());
    }

    // Mock response: return a single paper.
    Ok(vec![ArxivPaper {
        id: "2301.00001".to_string(),
        title: format!("Mock paper for query: {}", query),
        authors: vec!["John Doe".to_string(), "Jane Smith".to_string()],
        summary: "This is a mock abstract. Real implementation will parse arXiv Atom feed.".to_string(),
        published: "2023-01-01T00:00:00Z".to_string(),
        pdf_url: "https://arxiv.org/pdf/2301.00001.pdf".to_string(),
    }])
}

/// `read_paper` — fetches metadata for a specific arXiv paper by ID.
/// 
/// Example query:
/// `http://export.arxiv.org/api/query?id_list=2301.00001`
/// 
/// This function is a stub that returns mock data for now.
pub fn read_paper(arxiv_id: &str) -> Result<ArxivPaper, Box<dyn Error>> {
    // TODO: Implement real HTTP request to arXiv API.
    
    if arxiv_id.is_empty() {
        return Err("arxiv_id cannot be empty".into());
    }

    // Mock response.
    Ok(ArxivPaper {
        id: arxiv_id.to_string(),
        title: format!("Paper {}", arxiv_id),
        authors: vec!["Author A".to_string()],
        summary: "Mock summary for specific paper.".to_string(),
        published: "2023-06-15T00:00:00Z".to_string(),
        pdf_url: format!("https://arxiv.org/pdf/{}.pdf", arxiv_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `search_arxiv_returns_papers_for_valid_query`: a non-empty query
    /// with max_results > 0 returns at least one paper (mock data).
    #[test]
    fn search_arxiv_returns_papers_for_valid_query() {
        let papers = search_arxiv("neural networks", 10).unwrap();
        assert!(!papers.is_empty());
        assert!(papers[0].title.contains("neural networks"));
    }

    /// `search_arxiv_empty_query_returns_error`: an empty query string
    /// is rejected with an error.
    #[test]
    fn search_arxiv_empty_query_returns_error() {
        let result = search_arxiv("", 10);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("cannot be empty"));
    }

    /// `search_arxiv_zero_max_results_returns_empty_vec`: requesting zero
    /// results returns an empty vector (no error).
    #[test]
    fn search_arxiv_zero_max_results_returns_empty_vec() {
        let papers = search_arxiv("transformers", 0).unwrap();
        assert!(papers.is_empty());
    }

    /// `search_arxiv_result_has_required_fields`: each returned paper has
    /// all required fields (id, title, authors, summary, published, pdf_url).
    #[test]
    fn search_arxiv_result_has_required_fields() {
        let papers = search_arxiv("deep learning", 5).unwrap();
        assert!(!papers.is_empty());
        let paper = &papers[0];
        assert!(!paper.id.is_empty());
        assert!(!paper.title.is_empty());
        assert!(!paper.authors.is_empty());
        assert!(!paper.summary.is_empty());
        assert!(!paper.published.is_empty());
        assert!(!paper.pdf_url.is_empty());
    }

    /// `read_paper_returns_paper_for_valid_id`: a valid arXiv ID returns
    /// a paper with matching ID (mock data).
    #[test]
    fn read_paper_returns_paper_for_valid_id() {
        let paper = read_paper("2301.00001").unwrap();
        assert_eq!(paper.id, "2301.00001");
        assert!(!paper.title.is_empty());
    }

    /// `read_paper_empty_id_returns_error`: an empty arXiv ID is rejected.
    #[test]
    fn read_paper_empty_id_returns_error() {
        let result = read_paper("");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("cannot be empty"));
    }

    /// `read_paper_result_has_pdf_url`: the returned paper has a valid
    /// PDF URL pointing to arxiv.org/pdf/<id>.pdf.
    #[test]
    fn read_paper_result_has_pdf_url() {
        let paper = read_paper("2401.12345").unwrap();
        assert_eq!(paper.pdf_url, "https://arxiv.org/pdf/2401.12345.pdf");
    }

    /// `search_arxiv_authors_is_non_empty_vec`: each paper has at least
    /// one author (the authors field is a Vec<String>).
    #[test]
    fn search_arxiv_authors_is_non_empty_vec() {
        let papers = search_arxiv("machine learning", 1).unwrap();
        assert!(!papers.is_empty());
        assert!(!papers[0].authors.is_empty());
    }
}
