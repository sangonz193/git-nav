//! Serves diff images by URL instead of embedding them in the diff payload. A token names one blob
//! or working tree file and lives only in this process, so a URL never carries a repository path
//! or revision, and the webview fetches, decodes and caches the bytes like any other image.

use tauri::http::{header, Response, StatusCode};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Read,
    path::Path,
    sync::Mutex,
};

use crate::git::{WORKTREE_REF, git_output_bytes, worktree_path};

pub(crate) const IMAGE_PREVIEW_LIMIT: usize = 64 * 1024 * 1024;

pub(crate) const URI_SCHEME: &str = "git-nav-image";

// Every token minted is kept until this many newer ones push it out, which covers every image a
// diff panel can be scrolled through in one sitting.
const TOKEN_CAPACITY: usize = 4096;

#[derive(Clone)]
pub(crate) struct ImageSource {
    pub(crate) repo_path: String,
    pub(crate) revision: String,
    pub(crate) path: String,
    pub(crate) mime: &'static str,
}

#[derive(Default)]
struct Tokens {
    sources: HashMap<String, ImageSource>,
    order: VecDeque<String>,
}

static TOKENS: Mutex<Option<Tokens>> = Mutex::new(None);

fn with_tokens<T>(apply: impl FnOnce(&mut Tokens) -> T) -> T {
    let mut guard = TOKENS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    apply(guard.get_or_insert_with(Tokens::default))
}

pub(crate) fn mint(source: ImageSource) -> String {
    let token = crate::sharing::generated_token();
    with_tokens(|tokens| {
        tokens.sources.insert(token.clone(), source);
        tokens.order.push_back(token.clone());
        while tokens.order.len() > TOKEN_CAPACITY {
            if let Some(oldest) = tokens.order.pop_front() {
                tokens.sources.remove(&oldest);
            }
        }
    });
    token
}

fn lookup(token: &str) -> Option<ImageSource> {
    with_tokens(|tokens| tokens.sources.get(token).cloned())
}

fn read(source: &ImageSource) -> Result<Vec<u8>, String> {
    if source.revision != WORKTREE_REF {
        let object = crate::diff::object_name(&source.revision, &source.path);
        return git_output_bytes(&source.repo_path, &["show", &object])
            .ok_or_else(|| format!("Could not read {} at {}.", source.path, source.revision));
    }
    let root = worktree_path(&source.repo_path)?;
    let file = fs::File::open(Path::new(&root).join(&source.path)).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.file_type().is_file() {
        return Err(format!("{} is not a regular file.", source.path));
    }
    let mut bytes = Vec::new();
    file.take(IMAGE_PREVIEW_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > IMAGE_PREVIEW_LIMIT {
        return Err(format!("{} is too large to preview.", source.path));
    }
    Ok(bytes)
}

fn plain(status: StatusCode, message: String) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.into_bytes())
        .expect("a plain response is always valid")
}

/// Answers both transports: the desktop URI scheme and the browser's `/api/diff_image` route.
pub(crate) fn response(token: &str) -> Response<Vec<u8>> {
    let Some(source) = lookup(token) else {
        return plain(StatusCode::NOT_FOUND, "Unknown image.".to_string());
    };
    match read(&source) {
        // A token is minted per read, so the URL changes whenever the bytes could have.
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, source.mime)
            .header(header::CACHE_CONTROL, "private, max-age=31536000, immutable")
            .body(bytes)
            .expect("an image response is always valid"),
        Err(message) => plain(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{remove_scratch_repository, scratch_repository};

    fn source(repo_path: &str, revision: &str, path: &str) -> ImageSource {
        ImageSource {
            repo_path: repo_path.to_string(),
            revision: revision.to_string(),
            path: path.to_string(),
            mime: "image/png",
        }
    }

    #[test]
    fn serves_a_committed_blob_and_a_working_tree_file_by_token() {
        let (path, run) = scratch_repository("image-tokens");
        fs::write(Path::new(&path).join("shot.png"), b"\x89PNG\0old").unwrap();
        run(&["add", "."]);
        run(&["commit", "--quiet", "--message", "base"]);
        fs::write(Path::new(&path).join("shot.png"), b"\x89PNG\0new!").unwrap();

        let committed = mint(source(&path, "HEAD", "shot.png"));
        let worktree = mint(source(&path, WORKTREE_REF, "shot.png"));
        let committed_response = response(&committed);
        let worktree_response = response(&worktree);
        remove_scratch_repository(&path);

        assert_ne!(committed, worktree);
        assert_eq!(committed_response.status(), StatusCode::OK);
        assert_eq!(committed_response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(committed_response.body(), b"\x89PNG\0old");
        assert_eq!(worktree_response.body(), b"\x89PNG\0new!");
    }

    #[test]
    fn unknown_tokens_are_not_found() {
        assert_eq!(response("nope").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_source_that_stopped_being_readable_reports_the_failure() {
        let (path, _run) = scratch_repository("image-tokens-missing");
        let token = mint(source(&path, WORKTREE_REF, "gone.png"));
        remove_scratch_repository(&path);

        assert_eq!(response(&token).status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
