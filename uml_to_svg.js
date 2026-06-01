const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_PATH = path.join(__dirname, 'uml-bundle.js');
// GitGraph lives outside the UML bundle (it's a sibling diagram type), so the
// gitgraph renderer needs window.GitGraph loaded separately, before the bundle.
const GIT_GRAPH_PATH = path.join(REPO_ROOT, 'js', 'git-graph.js');
const CACHE_DIR = path.join(REPO_ROOT, '.uml_cache');

// Read the renderer sources once. The cache key is derived from their content
// so that a renderer change invalidates stale SVGs automatically.
const BUNDLE_JS = fs.readFileSync(BUNDLE_PATH, 'utf8');
const GIT_GRAPH_JS = fs.existsSync(GIT_GRAPH_PATH) ? fs.readFileSync(GIT_GRAPH_PATH, 'utf8') : '';
const BUNDLE_HASH = crypto.createHash('md5').update(BUNDLE_JS + GIT_GRAPH_JS).digest('hex');

// Built once and reused for every render. GitGraph is loaded before the bundle
// so window.GitGraph exists when the gitgraph renderer initializes.
const PAGE_HTML = `
    <html>
    <head>
        <style>
            .uml-class-diagram-container { display: block; }
        </style>
        <script>${GIT_GRAPH_JS}</script>
        <script>${BUNDLE_JS}</script>
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
    const hash = crypto.createHash('md5').update(BUNDLE_HASH + '|' + type + '|' + text).digest('hex');
    return path.join(CACHE_DIR, hash + '.svg');
}

// Runs inside the browser page. Returns the rendered SVG markup, or an
// 'Error: ...' string the caller detects (and never caches). Wrapping the
// renderer in try/catch keeps one malformed diagram from rejecting the whole
// page.evaluate and aborting a batch build.
function renderInPage(page, type, text) {
    return page.evaluate(async ({ type, text }) => {
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
        const svgEl = container.querySelector('svg');
        return svgEl ? svgEl.outerHTML : 'Error: No SVG generated';
    }, { type, text });
}

async function renderUML(type, text) {
    const cachePath = cachePathFor(type, text);
    if (fs.existsSync(cachePath)) {
        return fs.readFileSync(cachePath, 'utf8');
    }

    const browser = await chromium.launch();
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

module.exports = { renderUML };

// Batch mode: read `{ id: { type, text } }` from stdin, write `{ id: svg }` to
// stdout. SVG values start with '<svg'; failures are 'Error: ...' strings that
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

        const browser = await chromium.launch();
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
