import { WORKSPACE_FILE_PATHS_SCRIPT } from "./workspace-file-paths.js";

/** @internal The assembler cannot publish; publication is a separate, tracked child. */
export const WORKSPACE_UPLOAD_SCRIPT = `
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
let C = {}, q, preparedDirectory, preparedIdentity;
const err = (code, message, extra) => Object.assign(new Error(message), { psCode: code }, extra || {});
${WORKSPACE_FILE_PATHS_SCRIPT}
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    q = JSON.parse(Buffer.concat(chunks).toString("utf8")); C = q.codes;
    process.stdout.write(JSON.stringify({ok:true,result:run()}));
  } catch (e) {
    let preparationSafe = q && q.op === "prepare" && !preparedDirectory;
    if(q && q.op === "prepare" && preparedDirectory && preparedIdentity) {
      try {
        if(!same(identity(preparedDirectory),preparedIdentity)) throw Error("changed");
        const names=fs.readdirSync(preparedDirectory);
        if(names.some((name)=>!["owner","probe","probe-link","probe-renamed"].includes(name))) throw Error("unknown entries");
        for(const name of names) fs.unlinkSync(path.join(preparedDirectory,name));
        fs.rmdirSync(preparedDirectory); preparationSafe=true;
      } catch { preparationSafe=false; }
    }
    const map = { ENOENT:C.NOT_FOUND, EEXIST:C.EXISTS, EACCES:C.READ_ONLY, EPERM:C.READ_ONLY, EROFS:C.READ_ONLY, ENOSPC:"WORKSPACE_FILES_UPLOAD_QUOTA", EDQUOT:"WORKSPACE_FILES_UPLOAD_QUOTA" };
    const code = e.psCode || map[e.code] || C.IO;
    const status = code === C.CONFLICT || code === C.EXISTS ? 409 : code === C.READ_ONLY ? 403 : code === C.NOT_FOUND ? 404 : code === "WORKSPACE_FILES_UPLOAD_QUOTA" ? 507 : 400;
    process.stdout.write(JSON.stringify({ok:false,code,status,preparationSafe,message:e.psCode ? e.message : "Workspace upload filesystem operation failed (" + (e.code || "IO") + ").",...(Object.hasOwn(e,"etag") ? {etag:e.etag} : {})}));
  }
});
const identity = (p) => { const s = fs.lstatSync(p,{bigint:true}); return {dev:String(s.dev),ino:String(s.ino)}; };
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;
function digest(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const h = crypto.createHash("sha256"), buffer = Buffer.alloc(65536);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw err(C.NOT_A_FILE, "not a regular file");
    if (before.size > limit) throw err(C.TOO_LARGE, "the existing file exceeds the configured file limit");
    let total = 0, n;
    while ((n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit - total + 1), null)) > 0) {
      total += n;
      if (total > limit) throw err(C.TOO_LARGE,"the file grew beyond the file limit");
      h.update(buffer.subarray(0,n));
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw err(C.CONFLICT,"the file changed while hashing it");
    return "sha256:" + h.digest("hex");
  } finally { fs.closeSync(fd); }
}
function target() {
  const loc = locate(q.base,q.rootPath,q.path,q);
  if (!inside(loc.realBase,loc.realRoot)) throw err(C.OUTSIDE,"the opened folder resolves outside its configured root");
  if (!loc.rel) throw err(C.NOT_A_FILE,"the folder itself is not a file");
  const why = protectedWhy(loc);
  if (why) throw err(C.READ_ONLY,why);
  return loc;
}
function binding(loc) {
  return {root:loc.realRoot,base:loc.realBase,target:loc.real,rootId:identity(loc.realRoot),baseId:identity(loc.realBase),parentId:identity(path.dirname(loc.real))};
}
function validateBinding(loc) {
  const now = binding(loc), b = q.binding;
  if (b && (b.root !== now.root || b.base !== now.base || b.target !== now.target || !same(b.rootId,now.rootId) || !same(b.baseId,now.baseId) || !same(b.parentId,now.parentId))) throw err(C.CONFLICT,"the workspace folder or destination changed during upload");
  return now;
}
function conditions(loc) {
  let st;
  try { st = fs.statSync(loc.real); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (st && !st.isFile()) throw err(C.NOT_A_FILE,"not a regular file");
  if (st && q.ifMatch === null) throw err(C.EXISTS,"a file with this name already exists");
  if (typeof q.ifMatch === "string") {
    const etag = st ? digest(loc.real,q.maxBytes) : null;
    if (etag !== q.ifMatch) throw err(C.CONFLICT,"the file changed since it was read",{etag});
  }
  return st;
}
function staging(loc) {
  const dir = path.join(path.dirname(loc.real), ".pilotswarm-transfer-" + q.id);
  if (q.stage && (q.stage.path !== dir || !same(identity(dir),q.stage.identity))) throw err(C.CONFLICT,"the private upload staging directory changed");
  if (q.stage) {
    const marker = fs.readFileSync(path.join(dir,"owner"),"utf8");
    if (marker !== q.id) throw err(C.CONFLICT,"the private upload staging owner changed");
  }
  return dir;
}
function run() {
  const loc = target();
  const spool = fs.realpathSync(q.spool);
  if(q.spoolIdentity && (fs.lstatSync(q.spool).isSymbolicLink() || !same(identity(q.spool),q.spoolIdentity))) throw err(C.CONFLICT,"private transfer storage changed");
  if (inside(spool,loc.realRoot) || inside(loc.realRoot,spool)) throw err(C.OUTSIDE,"transfer storage must be outside workspace roots");
  for(const root of q.roots || []) {
    let real=path.resolve(root.path);
    try { real=fs.realpathSync(real); } catch(e) { if(e.code!=="ENOENT") throw e; }
    if(inside(spool,real) || inside(real,spool)) throw err(C.OUTSIDE,"transfer storage must be outside every workspace root");
  }
  if (q.op === "prepare") {
    if (q.createParents) fs.mkdirSync(path.dirname(loc.real),{recursive:true});
    const b = validateBinding(loc);
    conditions(loc);
    const dir = staging(loc);
    fs.mkdirSync(dir,{mode:0o700});
    preparedDirectory=dir; preparedIdentity=identity(dir);
    // The local manifest exists before this helper can create destination entries.
    fs.writeFileSync(path.join(dir,"owner"),q.id,{flag:"wx",mode:0o600});
    const a=path.join(dir,"probe"), link=path.join(dir,"probe-link"), renamed=path.join(dir,"probe-renamed");
    try {
      fs.writeFileSync(a,"",{flag:"wx",mode:0o600});
      fs.linkSync(a,link); fs.renameSync(link,renamed);
    } catch (e) {
      throw err("WORKSPACE_FILES_UPLOAD_UNSUPPORTED","this workspace does not support exclusive hard-link creation and atomic rename");
    } finally {
      for (const p of [a,link,renamed]) { try { fs.unlinkSync(p); } catch(e) { if(e.code !== "ENOENT") throw e; } }
    }
    return {binding:b,stage:{path:dir,identity:identity(dir)}};
  }
  validateBinding(loc);
  const dir = staging(loc), candidate=path.join(dir,"candidate");
  if (q.op === "validate") return {};
  if (q.op === "candidate") {
    const fd = fs.openSync(candidate,"wx",0o600);
    try { return {identity:identity(candidate)}; } finally { fs.closeSync(fd); }
  }
  if (q.op === "cleanup") {
    if (fs.existsSync(candidate)) {
      if (!q.candidate || !same(identity(candidate),q.candidate)) throw err(C.CONFLICT,"the upload candidate identity is uncertain; capacity remains reserved");
      fs.unlinkSync(candidate);
    }
    fs.unlinkSync(path.join(dir,"owner")); fs.rmdirSync(dir);
    return {};
  }
  if (q.op === "assemble") {
    if (!same(identity(candidate),q.candidate)) throw err(C.CONFLICT,"the upload candidate changed");
    const fd=fs.openSync(candidate,fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)), hash=crypto.createHash("sha256"), buffer=Buffer.alloc(65536);
    let total=0;
    try {
      for (let part=0;part<q.partCount;part++) {
        const source=fs.openSync(path.join(q.spool,String(part)),fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const expected=Math.min(q.partBytes,q.size-part*q.partBytes), st=fs.fstatSync(source);
          if (!st.isFile() || st.size !== expected) throw err("WORKSPACE_FILES_UPLOAD_INCOMPLETE","an accepted upload part is missing or changed");
          let n, count=0, partHash=crypto.createHash("sha256");
          while ((n=fs.readSync(source,buffer,0,Math.min(buffer.length,expected-count+1),null)) > 0) {
            count+=n; total+=n;
            if(count>expected || total>q.size) throw err("WORKSPACE_FILES_UPLOAD_INTEGRITY","upload part exceeds its reserved size");
            let written=0;
            while(written<n) written+=fs.writeSync(fd,buffer,written,n-written);
            hash.update(buffer.subarray(0,n));
            partHash.update(buffer.subarray(0,n));
          }
          if(count!==expected) throw err("WORKSPACE_FILES_UPLOAD_INCOMPLETE","upload part is truncated");
          if(partHash.digest("hex")!==q.receipts[part].sha256) throw err("WORKSPACE_FILES_UPLOAD_INTEGRITY","an accepted upload part changed");
        } finally { fs.closeSync(source); }
      }
      if(total!==q.size) throw err("WORKSPACE_FILES_UPLOAD_INCOMPLETE","upload is incomplete");
      const etag="sha256:"+hash.digest("hex");
      if(q.sha256 && etag!=="sha256:"+q.sha256) throw err("WORKSPACE_FILES_UPLOAD_INTEGRITY","the uploaded file checksum does not match");
      fs.fsyncSync(fd);
      return {etag,identity:identity(candidate)};
    } finally { fs.closeSync(fd); }
  }
  if(q.op==="publish") {
    const st=conditions(loc);
    if(!same(identity(candidate),q.candidate)) throw err(C.CONFLICT,"the upload candidate changed");
    fs.chmodSync(candidate,st ? st.mode & 0o7777 : 0o644);
    // A create-only publish must never overwrite a file created after conditions().
    if(q.ifMatch===null) fs.linkSync(candidate,loc.real);
    else fs.renameSync(candidate,loc.real);
    const saved=fs.statSync(loc.real);
    return {etag:q.etag,size:q.size,mtimeMs:saved.mtimeMs,created:!st};
  }
  throw err(C.PATH_INVALID,"unknown upload operation");
}
`;
