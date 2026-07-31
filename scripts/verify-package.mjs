/**
 * Verifies a packaged .streamDeckPlugin before it is released.
 *
 * Every check here corresponds to a defect that actually shipped or nearly shipped, and that
 * was only caught by inspecting the archive by hand:
 *
 *   - the native host missing entirely, because `npm run build` does not build it and the
 *     plugin then falls back to a browser silently
 *   - the host present but with an invalid code signature after `lipo`
 *   - an icon referenced by the code but absent from the package, which renders as blank space
 *   - the packaged manifest version not matching the working tree
 *
 * Exits non-zero on any failure so it can gate a release.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = "com.quickclips.streamdeck.sdPlugin";
const ARCHIVE = "com.quickclips.streamdeck.streamDeckPlugin";
const HOST = `${PLUGIN_DIR}/bin/picker-host`;

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => notes.push(`  ok    ${msg}`);

/** Lists archive entries as `path -> size`, via unzip so there is no zip dependency. */
function archiveEntries() {
    const out = execFileSync("unzip", ["-l", ARCHIVE], { encoding: "utf8" });
    const entries = new Map();
    for (const line of out.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(\S.*)$/);
        if (m && !m[2].endsWith("/")) entries.set(m[2].replace(/^[^/]+\//, ""), Number(m[1]));
    }
    return entries;
}

if (!existsSync(ARCHIVE)) {
    console.error(`verify: ${ARCHIVE} not found — run the pack step first`);
    process.exit(1);
}

const entries = archiveEntries();
const inArchive = (p) => entries.has(p);

// --- 1. version agreement -------------------------------------------------------------------
const treeVersion = require(`../${PLUGIN_DIR}/manifest.json`).Version;
const packedManifest = execFileSync("unzip", ["-p", ARCHIVE, `${PLUGIN_DIR}/manifest.json`], { encoding: "utf8" });
const packedVersion = JSON.parse(packedManifest).Version;
if (treeVersion !== packedVersion) {
    fail(`packaged version ${packedVersion} does not match the working tree (${treeVersion}) — repack`);
} else {
    ok(`version ${packedVersion} matches the working tree`);
}

// --- 2. the plugin bundle -------------------------------------------------------------------
const bundle = "bin/plugin.js";
if (!inArchive(bundle)) {
    fail(`${bundle} missing from the package`);
} else if (entries.get(bundle) < 10_000) {
    fail(`${bundle} is only ${entries.get(bundle)} bytes — the build probably failed`);
} else {
    ok(`${bundle} present (${entries.get(bundle)} bytes)`);
}

// --- 3. the native window host --------------------------------------------------------------
// Absence is the dangerous case: the plugin falls back to a browser without complaint, so a
// release built without `npm run build:native` looks fine until someone has no browser.
if (!inArchive("bin/picker-host")) {
    fail("bin/picker-host missing from the package — run `npm run build:native` before packing");
} else {
    ok(`bin/picker-host present (${entries.get("bin/picker-host")} bytes)`);

    if (!existsSync(HOST)) {
        fail(`${HOST} is in the archive but not on disk, which should be impossible`);
    } else {
        if (!(statSync(HOST).mode & 0o111)) {
            fail(`${HOST} is not executable on disk`);
        } else {
            ok("host is executable on disk");
        }
        // `lipo` does not re-sign what it produces, leaving a binary that claims adhoc but fails
        // verification. Both slices still run, yet an invalid signature blocks notarization.
        try {
            execFileSync("codesign", ["--verify", HOST], { stdio: "pipe" });
            ok("host code signature verifies");
        } catch {
            fail(`${HOST} has an invalid code signature — native/build.sh should re-sign after lipo`);
        }
        try {
            const archs = execFileSync("lipo", ["-archs", HOST], { encoding: "utf8" }).trim();
            for (const want of ["arm64", "x86_64"]) {
                if (!archs.includes(want)) fail(`host is missing the ${want} slice (has: ${archs})`);
            }
            if (archs.includes("arm64") && archs.includes("x86_64")) ok(`host is universal (${archs})`);
        } catch {
            fail("could not read host architectures");
        }
    }
}

// --- 3b. the bundle is a production build ----------------------------------------------------
// `npm run watch` rebuilds unminified and with a sourcemap. If it is running during a release it
// can overwrite the production bundle between `build` and `pack`, so the package silently ships a
// dev build. Caught here rather than trusted, because nothing else would notice.
{
    const packedJs = execFileSync("unzip", ["-p", ARCHIVE, `${PLUGIN_DIR}/${bundle}`], { encoding: "utf8" });
    const lines = packedJs.split("\n").length;
    if (packedJs.includes("sourceMappingURL")) {
        fail(`${bundle} references a sourcemap — that is a watch build, not a production one. ` +
             `Stop \`npm run watch\` and re-run the release.`);
    } else if (lines > 50) {
        fail(`${bundle} spans ${lines} lines and is not minified — likely a watch build. ` +
             `Stop \`npm run watch\` and re-run the release.`);
    } else {
        ok("bundle is a minified production build");
    }
}

// --- 4. every icon the code references is packaged ------------------------------------------
// Derived from the built bundle rather than the source, so it reflects what actually ships.
//
// Two reference styles exist and mean different things:
//   - a full path ending in .png (clipboard-slot's setImage calls) — that exact file must exist
//   - a bare base path (clipboard-utils / the picker) — Stream Deck and the picker each resolve
//     the density themselves, so at least one of .png / @2x.png must exist
//
// Requiring both densities everywhere would be wrong: the Quick Clips icons are @1x only.
// Hyphens must be in the character class or `release-to-clear` truncates to `release`.
const packedBundle = execFileSync("unzip", ["-p", ARCHIVE, `${PLUGIN_DIR}/${bundle}`], { encoding: "utf8" });
const referenced = [...new Set(
    [...packedBundle.matchAll(/imgs\/actions\/[\w/-]+(?:\.png)?/g)].map(m => m[0])
)];
let missingIcons = 0;
const noRetina = [];
for (const ref of referenced) {
    if (ref.endsWith(".png")) {
        if (!inArchive(ref)) {
            fail(`icon ${ref} is referenced by the code but not in the package`);
            missingIcons++;
        }
        continue;
    }
    const has1x = inArchive(`${ref}.png`);
    const has2x = inArchive(`${ref}@2x.png`);
    if (!has1x && !has2x) {
        fail(`icon ${ref} is referenced by the code but no .png or @2x.png is in the package`);
        missingIcons++;
    } else if (!has2x) {
        noRetina.push(ref);
    }
}
if (referenced.length === 0) {
    fail("no icon paths found in the bundle — the reference scan may be broken");
} else if (missingIcons === 0) {
    ok(`all ${referenced.length} referenced icons resolve in the package`);
    if (noRetina.length) {
        notes.push(`  note  ${noRetina.length} icon(s) have no @2x variant: ${noRetina.join(", ")}`);
    }
}

// --- report ---------------------------------------------------------------------------------
console.log(`\nverifying ${ARCHIVE}`);
for (const n of notes) console.log(n);
if (failures.length) {
    console.error("");
    for (const f of failures) console.error(`  FAIL  ${f}`);
    console.error(`\n${failures.length} problem(s) — not fit to release\n`);
    process.exit(1);
}
console.log(`\n${notes.length} checks passed\n`);
