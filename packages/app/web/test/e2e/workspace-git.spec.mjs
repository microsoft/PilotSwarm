// Git in the Workspace tab, against a fake repository behind the two Web API
// calls the pane makes (listSessionWorkspaceFolders, sessionWorkspaceFiles,
// including { op: "git" }). No server, no git: the pane's own behaviour.
//
//   a click into a read-only diff keeps keys in the pane (no session shortcut)
//   the diff cannot be edited
//   a file in Staged and Changes counts each part in its own group
//   "Changes since" closes a diff that compared with the old base
//   a pure rename says so, not "mode or attributes"
//   the working folder moving to another place drops the old History
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
// Session 0 is running (a turn), session 1 is idle: checkout needs an idle one.
const IDLE_SESSION = "11111111-2222-3333-4444-555555555551";
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const ok = (result) => ({ status: 200, body: { ok: true, result } });
const notFound = { status: 404, body: { ok: false, error: { code: "WORKSPACE_FILES_NOT_FOUND", message: "no such file or folder" } } };
const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";

/** A repository in memory: files on disk, the git answers, and the calls made. */
function fakeRepo({ disk, status, blobs = {}, commits = [], shows = {}, compares = {}, repos = { top: true, repos: [], truncated: false } }) {
    const calls = [];
    return {
        calls,
        status,
        handle(call) {
            calls.push(call);
            const path = call.path ?? "";
            if (call.op === "git" && call.what === "repos") return ok(repos);
            if (call.op === "git") {
                if (call.what === "status") return ok({ repo: true, available: true, ...this.status, since: call.since ? { sha: SHA1, label: SHA1.slice(0, 7) } : null });
                if (call.what === "log") return ok({ repo: true, available: true, commits, more: false });
                if (call.what === "show") return ok({ repo: true, available: true, ...shows[call.sha] });
                if (call.what === "compare") return ok({ repo: true, available: true, from: { sha: call.from, short: call.from.slice(0, 7) }, to: { sha: call.to, short: call.to.slice(0, 7) }, ...compares[`${call.from}..${call.to}`] });
                if (call.what === "file") {
                    const text = blobs[`${call.rev}:${path}`];
                    return ok(text === undefined ? { repo: true, available: true, exists: false } : { repo: true, available: true, exists: true, text });
                }
            }
            if (call.op === "list") {
                const prefix = path ? `${path}/` : "";
                const names = new Map();
                for (const p of Object.keys(disk)) {
                    if (!p.startsWith(prefix)) continue;
                    const rest = p.slice(prefix.length);
                    const at = rest.indexOf("/");
                    names.set(at < 0 ? rest : rest.slice(0, at), at < 0 ? "file" : "dir");
                }
                return ok({ entries: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1 })), truncated: false, readOnly: false });
            }
            if (call.op === "read") {
                if (disk[path] === undefined) return notFound;
                const bytes = Buffer.from(disk[path]);
                return ok({ contentBase64: bytes.toString("base64"), size: bytes.length, mtimeMs: 1, etag: `e:${disk[path].length}` });
            }
            if (call.op === "stat") return disk[path] === undefined ? notFound : ok({ kind: "file", size: 1, mtimeMs: 1, etag: `e:${disk[path].length}` });
            return ok({});
        },
    };
}

const folderAt = (place) => ({ id: "working", name: "app", role: "working", home: false, root: "a", folder: place, opened: true, available: true, base: `/ws/a/${place}` });

async function routeRepo(page, repo, { folders = () => [folderAt("sessions/s1/app")], session = sessionId } = {}) {
    await page.route("**/api/portal-config", (route) => route.fulfill({ json: { ok: true, portal: { branding: { title: "PilotSwarm", pageTitle: "PilotSwarm" }, workspaceFiles: true } } }));
    await page.route(`**/management/sessions/${session}/workspace/folders`, (route) => route.fulfill({ json: { ok: true, result: { enabled: true, git: true, maxBytes: 20 * 1024 * 1024, folders: folders() } } }));
    await page.route(`**/management/sessions/${session}/workspace/files`, (route) => {
        const { status, body } = repo.handle(route.request().postDataJSON().call);
        return route.fulfill({ status, json: body });
    });
}

async function openWorkspace(page, session = sessionId) {
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${session}`);
    await page.getByRole("button", { name: "Show canvas" }).click();
    await page.getByRole("tab", { name: "Workspace" }).click();
}

const sideTab = (page, name) => page.getByRole("tablist", { name: "What the list shows" }).getByRole("tab", { name: new RegExp(`^${name}`) });
const changeRow = (page, group, name) => page.locator(".ps-ws-git-list > .ps-ws-git-row").filter({ hasText: name }).nth(group === "Staged" ? 0 : 1);
const diffBar = (page) => page.locator(".ps-ws-diff-bar");

const BASIC = {
    disk: { "README.md": "one\nstaged line\ndisk line\n", "src/new.js": "same\n" },
    status: {
        head: SHA2,
        branch: "main",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        state: null,
        truncated: false,
        files: [
            { path: "README.md", letter: "M", staged: true, unstaged: true, added: 3, removed: 0, staged_counts: { added: 1, removed: 0 }, unstaged_counts: { added: 2, removed: 0 } },
            { path: "src/new.js", from: "src/old.js", letter: "R", staged: true, unstaged: false, added: 0, removed: 0, staged_counts: { added: 0, removed: 0 }, unstaged_counts: null },
        ],
    },
    blobs: {
        "HEAD:README.md": "one\n",
        "INDEX:README.md": "one\nstaged line\n",
        "HEAD:src/old.js": "same\n",
        "INDEX:src/new.js": "same\n",
        [`${SHA1}:README.md`]: "zero\n",
    },
    commits: [
        { sha: SHA2, short: "2222222", author: "Ada", email: "ada@example.test", time: 1_790_000_000, parents: [SHA1], refs: ["HEAD -> main"], subject: "Second" },
        { sha: SHA1, short: "1111111", author: "Ada", email: "ada@example.test", time: 1_789_000_000, parents: [], refs: [], subject: "First" },
    ],
};

test("a click into a read-only diff keeps keys in the pane: Shift+D does not ask to delete the session", async ({ page }) => {
    await routeRepo(page, fakeRepo(BASIC));
    await openWorkspace(page);
    await sideTab(page, "Changes").click();
    await changeRow(page, "Changes", "README.md").click();
    const text = page.locator(".ps-ws-diff .cm-content").last();
    await expect(text).toContainText("disk line");
    await text.click();
    // The focus is inside the pane, which answers its own keys.
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".ps-ws-pane[data-own-keys]")))).toBe(true);
    await page.keyboard.press("Shift+D");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /Delete Session/i })).toHaveCount(0);
    // And the diff cannot be edited.
    await page.keyboard.type("xyz");
    await expect(text).not.toContainText("xyz");
    await expect(page.locator(".ps-ws-diff .cm-content[contenteditable='true']")).toHaveCount(0);
});

test("a file in Staged and Changes counts each part in its own group", async ({ page }) => {
    await routeRepo(page, fakeRepo(BASIC));
    await openWorkspace(page);
    await sideTab(page, "Changes").click();
    await expect(changeRow(page, "Staged", "README.md").locator(".ps-ws-git-count")).toHaveText(["+1"]);
    await expect(changeRow(page, "Changes", "README.md").locator(".ps-ws-git-count")).toHaveText(["+2"]);
});

test("changing \"Changes since\" closes a diff that compared with the old base", async ({ page }) => {
    await routeRepo(page, fakeRepo(BASIC));
    await openWorkspace(page);
    await sideTab(page, "Changes").click();
    await changeRow(page, "Changes", "README.md").click();
    await expect(diffBar(page)).toContainText("Index ↔ Working Tree");
    await page.getByRole("combobox", { name: "Show changes since" }).selectOption("main");
    await expect(diffBar(page)).toHaveCount(0);
});

test("a pure rename says it was renamed, not that the mode changed", async ({ page }) => {
    await routeRepo(page, fakeRepo(BASIC));
    await openWorkspace(page);
    await sideTab(page, "Changes").click();
    const renamed = page.locator(".ps-ws-git-list > .ps-ws-git-row").filter({ hasText: "new.js" });
    await expect(renamed.locator(".ps-ws-git-from")).toHaveText("← old.js");
    await renamed.click();
    await expect(page.locator(".ps-ws-viewer-body")).toContainText("Renamed from src/old.js. The content did not change.");
});

test("the working folder moving to another place drops the old place's History", async ({ page }) => {
    let place = "sessions/s1/app";
    const first = fakeRepo({ ...BASIC, shows: { [SHA2]: { commit: { ...BASIC.commits[0], body: "", committer: "Ada", committerEmail: "", committedAt: 0 }, files: [] } } });
    await routeRepo(page, first, { folders: () => [folderAt(place)] });
    await openWorkspace(page);
    await sideTab(page, "History").click();
    await page.locator(".ps-ws-git-commit").filter({ hasText: "Second" }).click();
    await expect(page.locator(".ps-ws-git-commit-title")).toHaveText("Second");

    // The session moves its working folder: same folder id, another place.
    place = "sessions/s1/other";
    first.status = { ...BASIC.status, head: SHA1 };
    await page.locator(".ps-ws-toolbar").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".ps-ws-git-commit-title")).toHaveCount(0);
    await expect(page.getByText("Pick a commit to see what it changed.")).toBeVisible();
});

test("a clone inside the folder (a folder in home): clicking it shows its git", async ({ page }) => {
    const repo = fakeRepo({
        disk: { "notes/todo.md": "x\n", "pilotswarm/README.md": "one\ntwo\n", "other/.keep": "" },
        repos: { top: false, repos: ["other", "pilotswarm"], truncated: false },
        status: { ...BASIC.status, branch: "pr-97", files: [{ path: "README.md", letter: "M", staged: false, unstaged: true, added: 1, removed: 0, staged_counts: null, unstaged_counts: { added: 1, removed: 0 } }] },
        blobs: { "INDEX:README.md": "one\n" },
    });
    await routeRepo(page, repo);
    await openWorkspace(page);
    // Two repositories inside: a picker; the first is shown until another is chosen.
    const picker = page.getByRole("combobox", { name: "Repository" });
    await expect(picker).toHaveValue("other");
    const tree = page.getByRole("tree");
    await expect(tree.locator(".ps-ws-row").filter({ hasText: "pilotswarm" }).locator(".ps-ws-repo-mark")).toHaveCount(1);
    // Clicking the clone's folder shows its git.
    // A double-click (the first click switches git to the clone, the second
    // must land on the same folder: nothing moves while its status loads).
    await tree.locator(".ps-ws-row").filter({ hasText: "pilotswarm" }).dblclick();
    await expect(picker).toHaveValue("pilotswarm");
    await expect(page.locator(".ps-ws-branch")).toContainText("pr-97");
    // Its files carry the letters, at their place in the folder.
    await expect(tree.locator(".ps-ws-row").filter({ hasText: "README.md" }).locator(".ps-ws-git-letter")).toHaveText("M");
    // Its diff reads the clone's file and asks git about the clone.
    await sideTab(page, "Changes").click();
    await page.locator(".ps-ws-git-list > .ps-ws-git-row").filter({ hasText: "README.md" }).click();
    await expect(page.locator(".ps-ws-diff .cm-content").last()).toContainText("two");
    expect(repo.calls.some((c) => c.op === "read" && c.path === "pilotswarm/README.md")).toBe(true);
    expect(repo.calls.some((c) => c.what === "file" && c.repo === "pilotswarm" && c.path === "README.md")).toBe(true);
    expect(repo.calls.filter((c) => c.what === "status").every((c) => c.repo === "other" || c.repo === "pilotswarm")).toBe(true);
});

const SHA0 = "0000000000000000000000000000000000000000";
const HISTORY = {
    ...BASIC,
    commits: [BASIC.commits[0], BASIC.commits[1], { sha: SHA0, short: "0000000", author: "Ada", email: "ada@example.test", time: 1_788_000_000, parents: [], refs: [], subject: "Zero" }],
    shows: {
        [SHA2]: { commit: { ...BASIC.commits[0], body: "", committer: "Ada", committerEmail: "", committedAt: 0 }, files: [{ path: "README.md", letter: "M", staged: false, unstaged: false, added: 1, removed: 0 }] },
    },
    compares: { [`${SHA0}..${SHA2}`]: { files: [{ path: "src/new.js", letter: "A", staged: false, unstaged: false, added: 1, removed: 0 }] } },
    blobs: { ...BASIC.blobs, [`${SHA1}:README.md`]: "one\n", [`${SHA2}:README.md`]: "one\ncommitted line\n", [`${SHA2}:src/new.js`]: "same\n" },
};

test("every commit in History opens its changes in the Changes tab, with its diffs", async ({ page }) => {
    await routeRepo(page, fakeRepo(HISTORY));
    await openWorkspace(page);
    await sideTab(page, "History").click();
    await page.getByRole("button", { name: "Changes in commit 2222222" }).click();
    await expect(sideTab(page, "Changes")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("combobox", { name: "Show changes since" })).toHaveValue(`commit:${SHA2}`);
    await expect(page.locator(".ps-ws-git-note")).toContainText("Second");
    const row = page.locator(".ps-ws-git-list > .ps-ws-git-row").filter({ hasText: "README.md" });
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(diffBar(page)).toContainText("2222222^ ↔ 2222222");
    await expect(page.locator(".ps-ws-diff .cm-content").last()).toContainText("committed line");
    // Back to the working tree's changes.
    await page.getByRole("combobox", { name: "Show changes since" }).selectOption("");
    await expect(page.locator(".ps-ws-git-list > .ps-ws-git-row")).toHaveCount(3);
});

test("two commits picked in History compare in the Changes tab", async ({ page }) => {
    await routeRepo(page, fakeRepo(HISTORY));
    await openWorkspace(page);
    await sideTab(page, "History").click();
    const commit = (subject) => page.locator(".ps-ws-git-commit").filter({ hasText: subject });
    await commit("Second").click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByRole("toolbar", { name: "Picked commits" })).toContainText("2222222 picked");
    await commit("Zero").click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("toolbar", { name: "Picked commits" }).getByRole("button", { name: "Compare" }).click();
    // Older first, whichever was picked first.
    await expect(page.getByRole("combobox", { name: "Show changes since" })).toHaveValue(`range:${SHA0}..${SHA2}`);
    await page.locator(".ps-ws-git-list > .ps-ws-git-row").filter({ hasText: "new.js" }).click();
    await expect(diffBar(page)).toContainText("new.js (2222222, added)");
    // Added between them: one green file.
    await expect(page.locator(".ps-ws-diff .ps-ws-whole-added")).toHaveCount(1);
});


test("check out a commit from History (stashing the changes), return to the branch, put the changes back", async ({ page }) => {
    const repo = fakeRepo({ ...HISTORY, shows: { ...HISTORY.shows, [SHA1]: { commit: { ...BASIC.commits[1], body: "", committer: "Ada", committerEmail: "", committedAt: 0 }, files: [] } } });
    const clean = { ...BASIC.status, files: [] };
    const handle = repo.handle.bind(repo);
    repo.handle = (call) => {
        if (call.op === "git" && call.what === "checkout") {
            repo.calls.push(call);
            if (call.sha) {
                if (repo.status.files.length && !call.stash) return ok({ repo: true, available: true, done: false, needsStash: true, changes: repo.status.files.length });
                repo.status = { ...clean, head: call.sha, branch: null, previousBranch: "main", stash: { ref: "stash@{0}", message: "pilotswarm: before checking out 1111111 (from main)" } };
                return ok({ repo: true, available: true, done: true, to: call.sha.slice(0, 7), from: "main", detached: true, stashed: Boolean(call.stash) });
            }
            repo.status = { ...repo.status, head: SHA2, branch: call.branch, previousBranch: null };
            return ok({ repo: true, available: true, done: true, to: call.branch, from: "1111111", detached: false, stashed: false });
        }
        if (call.op === "git" && call.what === "restore") {
            repo.calls.push(call);
            repo.status = { ...BASIC.status, stash: null };
            return ok({ repo: true, available: true, done: true, message: "pilotswarm: before checking out 1111111 (from main)" });
        }
        return handle(call);
    };
    await routeRepo(page, repo, { session: IDLE_SESSION });
    await openWorkspace(page, IDLE_SESSION);
    await sideTab(page, "History").click();
    await page.locator(".ps-ws-git-commit").filter({ hasText: "First" }).click();
    await page.getByRole("button", { name: "Check out this commit" }).click();
    // Two uncommitted changes: the dialog offers to stash them.
    const dialog = page.getByRole("dialog", { name: "Check out commit 1111111" });
    await expect(dialog).toContainText("2 uncommitted changes");
    await dialog.getByRole("button", { name: "Stash and check out" }).click();
    expect(repo.calls.some((c) => c.what === "checkout" && c.sha === SHA1 && c.stash === true)).toBe(true);
    const back = page.locator(".ps-ws-toolbar").getByRole("button", { name: "Return to main" });
    await expect(back).toBeVisible();
    await expect(page.locator(".ps-ws-branch")).toContainText("detached at 1111111");
    // Clean now: going back needs no dialog.
    await back.click();
    expect(repo.calls.some((c) => c.what === "checkout" && c.branch === "main")).toBe(true);
    await expect(back).toHaveCount(0);
    await sideTab(page, "Changes").click();
    await page.getByRole("button", { name: "Put them back" }).click();
    expect(repo.calls.some((c) => c.what === "restore")).toBe(true);
    await expect(page.getByRole("button", { name: "Put them back" })).toHaveCount(0);
    await expect(page.locator(".ps-ws-git-list > .ps-ws-git-row")).toHaveCount(3);
});

test("while the agent is in a turn, checking out is not offered", async ({ page }) => {
    await routeRepo(page, fakeRepo({ ...HISTORY, shows: { ...HISTORY.shows, [SHA1]: { commit: { ...BASIC.commits[1], body: "", committer: "Ada", committerEmail: "", committedAt: 0 }, files: [] } } }));
    await openWorkspace(page);
    await sideTab(page, "History").click();
    await page.locator(".ps-ws-git-commit").filter({ hasText: "First" }).click();
    await expect(page.getByRole("button", { name: "Check out this commit" })).toBeDisabled();
});

test("each tab keeps its own viewer: a diff opened in Changes does not stay over the Files tab's file", async ({ page }) => {
    await routeRepo(page, fakeRepo(BASIC));
    await openWorkspace(page);
    // A file picked in Files.
    await page.getByRole("tree").locator(".ps-ws-row").filter({ hasText: "README.md" }).click();
    await expect(page.locator(".ps-ws-viewer .cm-content").first()).toContainText("disk line");
    // A diff in Changes.
    await sideTab(page, "Changes").click();
    await changeRow(page, "Staged", "README.md").click();
    await expect(diffBar(page)).toContainText("HEAD ↔ Index");
    // Back in Files: the picked file, not the diff.
    await sideTab(page, "Files").click();
    await expect(diffBar(page)).toHaveCount(0);
    await expect(page.locator(".ps-ws-viewer .ps-ws-crumb-leaf")).toHaveText("README.md");
    // And Changes still has its diff.
    await sideTab(page, "Changes").click();
    await expect(diffBar(page)).toContainText("HEAD ↔ Index");
});

test("picking something outside every repository drops the git context; the tabs stay put", async ({ page }) => {
    const repo = fakeRepo({
        disk: { "AGENTS.md": "# Mine\n", "pilotswarm/README.md": "one\n" },
        repos: { top: false, repos: ["pilotswarm"], truncated: false },
        status: { ...BASIC.status, branch: "pr-97", files: [] },
    });
    await routeRepo(page, repo);
    await openWorkspace(page);
    const tree = page.getByRole("tree");
    const branch = page.locator(".ps-ws-branch");
    await tree.locator(".ps-ws-row").filter({ hasText: "pilotswarm" }).click();
    await expect(branch).toContainText("pr-97");
    const tabsTop = await page.locator(".ps-ws-sidetabs").boundingBox();
    // A file next to the clone: no repository.
    await tree.locator(".ps-ws-row").filter({ hasText: "AGENTS.md" }).click();
    await expect(branch).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Repository" })).toHaveValue("\u0000none");
    await expect(sideTab(page, "Changes")).toBeDisabled();
    await expect(sideTab(page, "History")).toBeDisabled();
    expect((await page.locator(".ps-ws-sidetabs").boundingBox()).y).toBe(tabsTop.y);
    // Back inside the clone: its git again.
    await tree.locator(".ps-ws-row").filter({ hasText: "pilotswarm" }).click();
    await expect(branch).toContainText("pr-97");
    await expect(sideTab(page, "Changes")).toBeEnabled();
});
