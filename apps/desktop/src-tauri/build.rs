use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    // The directory has to exist even under `tauri dev`, which serves from devUrl instead.
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    fs::create_dir_all(&dist).expect("could not create the web asset directory");

    let mut assets = Vec::new();
    collect(&dist, &dist, &mut assets);
    assets.sort();

    // `include_bytes!` makes each asset a tracked dependency of the crate, so editing a file in
    // place rebuilds. Reading the directory from a macro would leave a stale binary behind instead.
    let entries = assets
        .iter()
        .map(|(name, path)| format!("    ({name:?}, include_bytes!({path:?})),\n"))
        .collect::<String>();
    let generated = format!("static ASSETS: &[(&str, &[u8])] = &[\n{entries}];\n");
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("assets.rs"), generated)
        .expect("could not write the asset table");

    println!("cargo:rerun-if-changed={}", dist.display());

    tauri_build::build()
}

fn collect(root: &Path, directory: &Path, assets: &mut Vec<(String, String)>) {
    println!("cargo:rerun-if-changed={}", directory.display());
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, assets);
        } else if let Ok(relative) = path.strip_prefix(root) {
            let name = relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            assets.push((name, path.to_string_lossy().into_owned()));
        }
    }
}
