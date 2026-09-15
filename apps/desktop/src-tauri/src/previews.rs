//! Downscaled copies of large images, so a preview costs the webview a small decode instead of a
//! whole photograph. Previews live in the user cache directory keyed by content, so a photograph is
//! decoded once per machine, and a background worker prepares them for a comparison ahead of the
//! cards scrolling into view.

use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use std::{
    collections::VecDeque,
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::Cursor,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Condvar, Mutex, Once},
};

use crate::git::{WORKTREE_REF, git_output};
use crate::images::{ImageSource, read};
use crate::storage::APPLICATION_IDENTIFIER;

// Twice the 320px preview height for high-density displays; the width bounds a panorama.
const MAX_WIDTH: u32 = 2560;
const MAX_HEIGHT: u32 = 640;
const JPEG_QUALITY: u8 = 85;
const CACHE_CAPACITY: usize = 2000;

pub(crate) struct Served {
    pub(crate) mime: &'static str,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
pub(crate) struct Dimensions {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

struct Cached {
    preview: PathBuf,
    size: PathBuf,
}

enum Materialized {
    Preview { dimensions: Option<Dimensions>, bytes: Vec<u8> },
    Original { dimensions: Option<Dimensions>, bytes: Vec<u8> },
}

impl Materialized {
    fn dimensions(&self) -> Option<Dimensions> {
        match self {
            Materialized::Preview { dimensions, .. } | Materialized::Original { dimensions, .. } => *dimensions,
        }
    }
}

fn cache_dir() -> Result<PathBuf, String> {
    let dir = dirs::cache_dir()
        .ok_or_else(|| "Could not locate the user cache directory.".to_string())?
        .join(APPLICATION_IDENTIFIER)
        .join("previews");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

// A blob is named by its object id; a working tree file by where it is and when it last changed.
fn cache_key(source: &ImageSource) -> Result<String, String> {
    if source.revision != WORKTREE_REF {
        let object = crate::diff::object_name(&source.revision, &source.path);
        return git_output(&source.repo_path, &["rev-parse", "--verify", &object])
            .ok_or_else(|| format!("Could not read {} at {}.", source.path, source.revision));
    }
    let root = crate::git::worktree_path(&source.repo_path)?;
    let metadata = fs::metadata(Path::new(&root).join(&source.path)).map_err(|error| error.to_string())?;
    let mut hasher = DefaultHasher::new();
    (root, &source.path, metadata.len(), metadata.modified().ok()).hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn cached(dir: &Path, source: &ImageSource) -> Result<Cached, String> {
    let key = cache_key(source)?;
    Ok(Cached {
        preview: dir.join(format!("{key}.{}", preview_extension(source.mime))),
        size: dir.join(format!("{key}.size")),
    })
}

fn preview_extension(mime: &str) -> &'static str {
    if mime == "image/jpeg" { "jpg" } else { "png" }
}

fn preview_mime(mime: &str) -> &'static str {
    if mime == "image/jpeg" { "image/jpeg" } else { "image/png" }
}

fn read_dimensions(path: &Path) -> Option<Dimensions> {
    let text = fs::read_to_string(path).ok()?;
    let (width, height) = text.trim().split_once(' ')?;
    Some(Dimensions { width: width.parse().ok()?, height: height.parse().ok()? })
}

fn needs_preview(format: ImageFormat, dimensions: Dimensions) -> bool {
    // Animated GIFs would lose their frames and icons hold several sizes, so neither is resampled.
    matches!(format, ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Bmp)
        && (dimensions.width > MAX_WIDTH || dimensions.height > MAX_HEIGHT)
}

fn encode(image: &DynamicImage, mime: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    if mime == "image/jpeg" {
        image
            .to_rgb8()
            .write_with_encoder(JpegEncoder::new_with_quality(&mut Cursor::new(&mut bytes), JPEG_QUALITY))
            .map_err(|error| error.to_string())?;
    } else {
        image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png).map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}

static WRITES: AtomicU64 = AtomicU64::new(0);

// The worker and a card can prepare the same source at once, so each write lands under its own name.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}-{}", std::process::id(), WRITES.fetch_add(1, Ordering::Relaxed)));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut previews: Vec<_> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "jpg" || extension == "png"))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    if previews.len() <= CACHE_CAPACITY {
        return;
    }
    previews.sort_unstable_by_key(|(modified, _)| *modified);
    for (_, path) in &previews[..previews.len() - CACHE_CAPACITY] {
        let _ = fs::remove_file(path.with_extension("size"));
        let _ = fs::remove_file(path);
    }
}

// The camera's orientation tag is honoured here because the resampled copy no longer carries it.
fn decode(bytes: &[u8]) -> Result<(Dimensions, Option<DynamicImage>), String> {
    let reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|error| error.to_string())?;
    let format = reader.format().ok_or_else(|| "Unrecognised image format.".to_string())?;
    let mut decoder = reader.into_decoder().map_err(|error| error.to_string())?;
    let (width, height) = decoder.dimensions();
    let dimensions = Dimensions { width, height };
    if !needs_preview(format, dimensions) {
        return Ok((dimensions, None));
    }
    let orientation = decoder.orientation().map_err(|error| error.to_string())?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?;
    image.apply_orientation(orientation);
    let dimensions = Dimensions { width: image.width(), height: image.height() };
    Ok((dimensions, Some(image.thumbnail(MAX_WIDTH, MAX_HEIGHT))))
}

fn materialize(dir: &Path, source: &ImageSource) -> Result<Materialized, String> {
    let cached = cached(dir, source)?;
    if let Ok(bytes) = fs::read(&cached.preview) {
        return Ok(Materialized::Preview { dimensions: read_dimensions(&cached.size), bytes });
    }
    let bytes = read(source)?;
    match decode(&bytes) {
        Ok((dimensions, Some(preview))) => {
            let bytes = encode(&preview, source.mime)?;
            // The size lands first so a preview on disk always has its dimensions beside it.
            write_atomically(&cached.size, format!("{} {}", dimensions.width, dimensions.height).as_bytes())?;
            write_atomically(&cached.preview, &bytes)?;
            prune(dir);
            Ok(Materialized::Preview { dimensions: Some(dimensions), bytes })
        }
        Ok((dimensions, None)) => Ok(Materialized::Original { dimensions: Some(dimensions), bytes }),
        // The webview may still manage a format this decoder does not, so it gets the original.
        Err(_) => Ok(Materialized::Original { dimensions: None, bytes }),
    }
}

/// Puts the preview for a source on disk when it needs one, and reports the source's pixel size.
pub(crate) fn prepare(source: &ImageSource) -> Result<Option<Dimensions>, String> {
    Ok(materialize(&cache_dir()?, source)?.dimensions())
}

/// The bytes an `<img>` receives: the preview when the source has one, else the source itself.
pub(crate) fn serve(source: &ImageSource) -> Result<Served, String> {
    Ok(match materialize(&cache_dir()?, source)? {
        Materialized::Preview { bytes, .. } => Served { mime: preview_mime(source.mime), bytes },
        Materialized::Original { bytes, .. } => Served { mime: source.mime, bytes },
    })
}

static QUEUE: Mutex<VecDeque<ImageSource>> = Mutex::new(VecDeque::new());
static WAKE: Condvar = Condvar::new();
static WORKER: Once = Once::new();

/// Prepares previews in the background in the order the cards will be scrolled through. A new
/// request replaces what is still pending, since it describes the comparison now on screen.
pub(crate) fn warm(sources: Vec<ImageSource>) {
    WORKER.call_once(|| {
        std::thread::Builder::new()
            .name("image-previews".to_string())
            .spawn(|| loop {
                let source = {
                    let mut queue = QUEUE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    while queue.is_empty() {
                        queue = WAKE.wait(queue).unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                    queue.pop_front().expect("the queue was just checked")
                };
                let _ = prepare(&source);
            })
            .expect("could not start the preview worker");
    });
    let mut queue = QUEUE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *queue = sources.into();
    WAKE.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{remove_scratch_repository, scratch_repository};
    use image::{ImageBuffer, Rgb};

    fn photograph(width: u32, height: u32) -> Vec<u8> {
        let image = ImageBuffer::from_fn(width, height, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 0]));
        let mut bytes = Vec::new();
        DynamicImage::ImageRgb8(image).write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png).unwrap();
        bytes
    }

    fn source(repo_path: &str, revision: &str, path: &str) -> ImageSource {
        ImageSource { repo_path: repo_path.to_string(), revision: revision.to_string(), path: path.to_string(), mime: "image/png" }
    }

    #[test]
    fn large_images_are_served_downscaled_and_small_ones_untouched() {
        let (path, run) = scratch_repository("image-previews");
        let dir = Path::new(&path).join(".previews");
        fs::create_dir_all(&dir).unwrap();
        let large = photograph(3000, 1500);
        let small = photograph(300, 150);
        fs::write(Path::new(&path).join("large.png"), &large).unwrap();
        fs::write(Path::new(&path).join("small.png"), &small).unwrap();
        run(&["add", "large.png", "small.png"]);
        run(&["commit", "--quiet", "--message", "images"]);

        let large_source = source(&path, "HEAD", "large.png");
        let first = materialize(&dir, &large_source).unwrap();
        let second = materialize(&dir, &large_source).unwrap();
        let untouched = materialize(&dir, &source(&path, WORKTREE_REF, "small.png")).unwrap();
        let cached: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(Result::ok).map(|entry| entry.file_name().into_string().unwrap()).collect();
        remove_scratch_repository(&path);

        let (Materialized::Preview { dimensions: Some(first_dimensions), bytes: first_bytes }, Materialized::Preview { dimensions: Some(second_dimensions), bytes: second_bytes }) = (first, second) else {
            panic!("a large photograph gets a preview");
        };
        assert_eq!((first_dimensions.width, first_dimensions.height), (3000, 1500));
        assert_eq!((second_dimensions.width, second_dimensions.height), (3000, 1500));
        assert_eq!(first_bytes, second_bytes);
        let preview = image::load_from_memory(&first_bytes).unwrap();
        assert_eq!((preview.width(), preview.height()), (1280, 640));
        assert_eq!(cached.len(), 2);
        assert!(cached.iter().any(|name| name.ends_with(".png")) && cached.iter().any(|name| name.ends_with(".size")));
        let Materialized::Original { dimensions: Some(dimensions), bytes } = untouched else {
            panic!("a small image is served as is");
        };
        assert_eq!((dimensions.width, dimensions.height), (300, 150));
        assert_eq!(bytes, small);
    }
}
