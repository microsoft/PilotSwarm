/** @internal Shared filesystem policy for deadline-bounded workspace file children. */
export const WORKSPACE_FILE_PATHS_SCRIPT = `
const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || !(r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r)); };
// Where a path lands. \`target\` is the path as written; \`real\` is where it
// really goes: the real path of its nearest existing part, then the rest.
// An unmounted root is an empty local folder, so a root without its marker
// is refused (writes would land on this machine's own disk).
function locate(base, rootPath, rel, q) {
  let realRoot;
  try { realRoot = fs.realpathSync(rootPath); } catch (e) { throw err(C.ROOT_UNAVAILABLE, "the root is missing here"); }
  if (q && q.requireMarker && !fs.existsSync(path.join(realRoot, ".pilotswarm-export"))) {
    throw err(C.ROOT_UNAVAILABLE, "the root is not mounted here: it has no .pilotswarm-export marker (or set PORTAL_WORKSPACE_REQUIRE_MARKER=false)");
  }
  let realBase;
  try { realBase = fs.realpathSync(base); } catch (e) { throw err(e.code === "ENOENT" ? C.NOT_FOUND : C.IO, "the folder is missing or unreadable"); }
  const target = path.resolve(realBase, rel || ".");
  if (!inside(target, realBase)) throw err(C.OUTSIDE, "the path leaves the folder");
  let probe = target;
  const rest = [];
  while (probe !== realBase && !fs.existsSync(probe)) { rest.unshift(path.basename(probe)); probe = path.dirname(probe); }
  const realProbe = fs.realpathSync(probe);
  if (!inside(realProbe, realBase)) throw err(C.OUTSIDE, "the path resolves outside the folder");
  const real = path.join(realProbe, ...rest);
  if ([target, real].some((p) => p.split(path.sep).some((part) => part.startsWith(".pilotswarm-transfer-")))) {
    throw err(C.READ_ONLY, "workspace transfer staging is private");
  }
  // Canvas apps never go through a link: their declared paths are checked
  // as written, so the path must be the place.
  if (q && q.noLinks && real !== target) throw err(C.OUTSIDE, "the path goes through a link; canvas apps do not follow links");
  return { realBase, realRoot, target, real, rel: path.relative(realBase, target) };
}
function protectedAt(loc, t) {
  if (!t) return null;
  if (path.relative(loc.realBase, t).split(path.sep).some((part) => part.toLowerCase() === ".git")) return "files inside .git are read-only here";
  if (path.basename(t).toLowerCase() === ".pilotswarm-export" && path.dirname(t) === loc.realRoot) return "the root's marker file is read-only";
  return null;
}
// Read-only: the path as written, and where it really goes (a link to .git
// is .git; on a disk that ignores case, .GIT is .git).
function protectedWhy(loc, target, real) {
  if (target) return protectedAt(loc, target) || protectedAt(loc, real);
  return protectedAt(loc, loc.target) || protectedAt(loc, loc.real);
}
`;
