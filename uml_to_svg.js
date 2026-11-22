const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// GitGraph lives outside the UML bundle (it's a sibling diagram type), so the
// gitgraph renderer needs window.GitGraph loaded separately, before the bundle.
const GIT_GRAPH_PATH = path.join(REPO_ROOT, 'js', 'git-graph.js');
const CACHE_DIR = path.join(REPO_ROOT, '.uml_cache');

/**
 * The C4 scripts a renderer page preloads, in load order: the manifest's `core`
 * and `render` lists, as `{ file, source }` with `file` relative to `archumlDir`.
 */
function readC4Scripts(archumlDir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(archumlDir, 'c4', 'manifest.json'), 'utf8'));
    return manifest.core.concat(manifest.render).map((file) => ({
        file,
        source: fs.readFileSync(path.join(archumlDir, file), 'utf8'),
    }));
}

/** Everything the prerender page runs, read from an ArchUML folder (this one in production). */
function readRendererInputs(archumlDir, gitGraphPath) {
    return {
        bundle: fs.readFileSync(path.join(archumlDir, 'uml-bundle.js'), 'utf8'),
        callouts: fs.readFileSync(path.join(archumlDir, 'css', 'callouts.css'), 'utf8'),
        driver: fs.readFileSync(path.join(archumlDir, 'uml_to_svg.js'), 'utf8'),
        gitGraph: fs.existsSync(gitGraphPath) ? fs.readFileSync(gitGraphPath, 'utf8') : '',
        c4Manifest: fs.readFileSync(path.join(archumlDir, 'c4', 'manifest.json'), 'utf8'),
        c4Scripts: readC4Scripts(archumlDir),
    };
}

function rendererFingerprint(sources) {
    const digest = crypto.createHash('sha256');
    for (const name of Object.keys(sources).sort()) {
        digest.update(name).update('\0').update(sources[name]).update('\0');
    }
    return digest.digest('hex');
}

/** The cache key part for the renderer: a change to any input, or to the C4 load order, invalidates cached SVGs. */
function rendererInputsFingerprint(inputs) {
    const { c4Scripts, ...files } = inputs;
    const c4Sources = Object.fromEntries(c4Scripts.map((script) => ['c4:' + script.file, script.source]));
    return rendererFingerprint({ ...files, ...c4Sources });
}

// Read the renderer sources once. The cache key is derived from their content
// so that a renderer change invalidates stale SVGs automatically.
const RENDERER_INPUTS = readRendererInputs(__dirname, GIT_GRAPH_PATH);
const CALLOUT_CSS = RENDERER_INPUTS.callouts;
const RENDERER_HASH = rendererInputsFingerprint(RENDERER_INPUTS);

/** `<script>` elements for inline sources; none of them contains `</script`. */
function inlineScripts(sources) {
    return sources.map((source) => `<script>${source}</script>`).join('\n');
}

// Built once and reused for every render. GitGraph is loaded before the bundle
// so window.GitGraph exists when the gitgraph renderer initializes, and the C4
// scripts load before it so the bundle's C4 stub renders synchronously.
const PAGE_HTML = `
    <html>
    <head>
        <style>
            .uml-class-diagram-container { display: block; }
        </style>
        ${inlineScripts([RENDERER_INPUTS.gitGraph])}
        ${inlineScripts(RENDERER_INPUTS.c4Scripts.map((script) => script.source))}
        ${inlineScripts([RENDERER_INPUTS.bundle])}
    </head>
    <body>
        <div id="container"></div>
    </body>
    </html>
`;

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePathFor(type, text) {
    const hash = crypto.createHash('md5').update(RENDERER_HASH + '|' + type + '|' + text).digest('hex');
    return path.join(CACHE_DIR, hash + '.svg');
}

// C4 views drawn as HTML (spec §6.6, Ruling 20): the interface card, or a C4
// figure body that holds a delegated drawing among its own text.
const C4_FRAGMENT_SELECTOR = 'article.c4-interface, .c4-figure-body';

// Runs inside the browser page. Returns the rendered SVG markup (or a C4 HTML
// fragment), or an 'Error: ...' string the caller detects (and never caches). Wrapping the
// renderer in try/catch keeps one malformed diagram from rejecting the whole
// page.evaluate and aborting a batch build.
function renderInPage(page, type, text) {
    return page.evaluate(async ({ type, text, calloutCss, fragmentSelector }) => {
        const RENDERERS = {
            class:         window.UMLClassDiagram,
            sequence:      window.UMLSequenceDiagram,
            state:         window.UMLStateDiagram,
            component:     window.UMLComponentDiagram,
            deployment:    window.UMLDeploymentDiagram,
            usecase:       window.UMLUseCaseDiagram,
            activity:      window.UMLActivityDiagram,
            freeform:      window.UMLFreeformDiagram,
            gitgraph:      window.UMLGitGraphDiagram,
            'folder-tree': window.UMLFolderTreeDiagram,
            venn:          window.UMLVennDiagram,
            er:            window.UMLERDiagram,
            crc:           window.UMLCRCDiagram,
            c4:            window.UMLC4Diagram,
        };
        const R = RENDERERS[type];
        if (!R || typeof R.render !== 'function') {
            return 'Error: Unknown renderer type: ' + type;
        }
        const container = document.getElementById('container');
        container.innerHTML = '';
        try {
            R.render(container, text);
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        } catch (err) {
            return 'Error: ' + (err && err.message ? err.message : String(err));
        }
        const fragment = container.querySelector(fragmentSelector);
        if (fragment) return fragment.outerHTML;
        const svgEl = container.querySelector('svg');
        if (svgEl && svgEl.classList.contains('uml-with-callouts')) {
            const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
            style.textContent = calloutCss;
            svgEl.prepend(style);
        }
        return svgEl ? svgEl.outerHTML : 'Error: No SVG generated';
    }, { type, text, calloutCss: CALLOUT_CSS, fragmentSelector: C4_FRAGMENT_SELECTOR });
}

// PLAYWRIGHT_CHROME_EXECUTABLE names an installed Chrome for machines where
// Playwright's bundled browser is not installed.
function launchBrowser() {
    const executablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
    return chromium.launch(executablePath ? { executablePath } : {});
}

async function renderUML(type, text) {
    const cachePath = cachePathFor(type, text);
    if (fs.existsSync(cachePath)) {
        return fs.readFileSync(cachePath, 'utf8');
    }

    const browser = await launchBrowser();
    try {
        const page = await browser.newPage();
        await page.setContent(PAGE_HTML);
        const svg = await renderInPage(page, type, text);
        if (!svg.startsWith('Error')) {
            fs.writeFileSync(cachePath, svg);
        }
        return svg;
    } finally {
        await browser.close();
    }
}

module.exports = { renderUML, rendererFingerprint, rendererInputsFingerprint, readRendererInputs, readC4Scripts };

// Batch mode: read `{ id: { type, text } }` from stdin, write `{ id: svg }` to
// stdout. SVG values start with '<svg' (C4 HTML fragments with their own
// root element); failures are 'Error: ...' strings that
// the caller (e.g. _plugins/uml_static.rb) detects and skips.
if (require.main === module) {
    (async () => {
        let input;
        try {
            input = JSON.parse(fs.readFileSync(0, 'utf8'));
        } catch (err) {
            process.stderr.write('uml_to_svg: invalid JSON on stdin: ' + (err.message || err) + '\n');
            process.exit(1);
            return;
        }

        const browser = await launchBrowser();
        const results = {};
        try {
            const page = await browser.newPage();
            await page.setContent(PAGE_HTML);

            for (const [id, diagram] of Object.entries(input)) {
                const { type, text } = diagram || {};
                const cachePath = cachePathFor(type, text);

                if (fs.existsSync(cachePath)) {
                    results[id] = fs.readFileSync(cachePath, 'utf8');
                    continue;
                }

                const svg = await renderInPage(page, type, text);
                if (!svg.startsWith('Error')) {
                    fs.writeFileSync(cachePath, svg);
                }
                results[id] = svg;
            }
        } finally {
            await browser.close();
        }

        process.stdout.write(JSON.stringify(results));
    })().catch((err) => {
        process.stderr.write('uml_to_svg: ' + (err && err.stack ? err.stack : err) + '\n');
        process.exit(1);
    });
}
