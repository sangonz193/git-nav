// The app is reached through a dynamic import so it lands in a chunk of its own, which leaves the entry
// small enough for the splash in index.html to paint before any of it is fetched or parsed.
void import("./mount.tsx")
