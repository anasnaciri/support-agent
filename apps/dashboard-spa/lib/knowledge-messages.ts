// Friendly text for the compact banner codes the knowledge actions redirect
// with (`error=<code>` or `error=<code>:<reason>`). Shared by the list page
// and the document editor.
export const knowledgeErrorMessage = (code: string): string => {
  const [error, reason] = code.split(":");
  switch (error) {
    case "invalid_title":
      return "Give the document a title.";
    case "missing_content":
      return "Paste some text for the document.";
    case "invalid_url":
      return "Enter a valid URL to fetch.";
    case "content_too_large":
      return "That document is too large (max 100,000 characters).";
    case "too_many_documents":
      return "You've reached the limit of 50 documents. Delete one to add another.";
    case "cannot_edit_url_content":
      return "This document is a URL snapshot. Edit it by re-syncing the page.";
    case "not_a_url_doc":
      return "Only URL documents can be re-synced.";
    case "fetch_failed":
      switch (reason) {
        case "blocked_host":
        case "blocked_scheme":
          return "That URL can't be fetched: it must be a public http(s) page.";
        case "too_large":
          return "That page is too large to import.";
        case "timeout":
          return "Fetching that URL timed out. Try again or paste the text.";
        case "no_text":
          return "We couldn't find readable text on that page.";
        default:
          return "We couldn't fetch that URL. Check the link or paste the text instead.";
      }
    default:
      return "Something went wrong. Please try again.";
  }
};
