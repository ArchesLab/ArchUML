const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_PATH = path.join(__dirname, 'uml-bundle.js');
<<<<<<< Updated upstream
const GIT_GRAPH_PATH = path.join(REPO_ROOT, 'js', 'git-graph.js');
=======
// GitGraph lives outside the UML bundle (it's a sibling diagram type), so we
// have to load it separately for the gitgraph renderer to find window.GitGraph.
const GITGRAPH_PATH = path.join(REPO_ROOT, 'js', 'git-graph.js');
>>>>>>> Stashed changes
const CACHE_DIR = path.join(REPO_ROOT, '.uml_cache');
const BUNDLE_HASH = crypto.createHash('md5').update(
    fs.readFileSync(BUNDLE_PATH, 'utf8') +
    fs.readFileSync(GITGRAPH_PATH, 'utf8')
).digest('hex');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

async function renderUML(type, text) {
    const hash = crypto.createHash('md5').update(BUNDLE_HASH + '|' + type + '|' + text).digest('hex');
    const cachePath = path.join(CACHE_DIR, hash + '.svg');

    if (fs.existsSync(cachePath)) {
        return fs.readFileSync(cachePath, 'utf8');
    }

    const browser = await chromium.launch();
    const page = await browser.newPage();
<<<<<<< Updated upstream
    
    // Create a minimal HTML with the bundle
    const gitGraphJs = fs.existsSync(GIT_GRAPH_PATH) ? fs.readFileSync(GIT_GRAPH_PATH, 'utf8') : '';
=======

    // Create a minimal HTML with the bundle + GitGraph (the gitgraph renderer
    // expects window.GitGraph to exist, and that lives outside the UML bundle).
>>>>>>> Stashed changes
    const bundleJs = fs.readFileSync(BUNDLE_PATH, 'utf8');
    const gitGraphJs = fs.readFileSync(GITGRAPH_PATH, 'utf8');
    const html = `
        <html>
        <head>
            <style>
                .uml-class-diagram-container { display: block; }
            </style>
            <script>${gitGraphJs}</script>
            <script>${bundleJs}</script>
            <script>${gitGraphJs}</script>
        </head>
        <body>
            <div id="container"></div>
        </body>
        </html>
    `;

    await page.setContent(html);

    const svg = await page.evaluate(async ({ type, text }) => {
        const container = document.getElementById('container');
        const RENDERERS = {
<<<<<<< Updated upstream
            class:      window.UMLClassDiagram,
            sequence:   window.UMLSequenceDiagram,
            state:      window.UMLStateDiagram,
            component:  window.UMLComponentDiagram,
            deployment: window.UMLDeploymentDiagram,
            usecase:    window.UMLUseCaseDiagram,
            activity:   window.UMLActivityDiagram,
            freeform:   window.UMLFreeformDiagram,
            gitgraph:   window.UMLGitGraphDiagram,
            'folder-tree': window.UMLFolderTreeDiagram,
            venn:       window.UMLVennDiagram,
            er:         window.UMLERDiagram,
=======
            class:         window.UMLClassDiagram,
            sequence:      window.UMLSequenceDiagram,
            state:         window.UMLStateDiagram,
            component:     window.UMLComponentDiagram,
            deployment:    window.UMLDeploymentDiagram,
            usecase:       window.UMLUseCaseDiagram,
            activity:      window.UMLActivityDiagram,
            freeform:      window.UMLFreeformDiagram,
            gitgraph:      window.UMLGitGraphDiagram,
            venn:          window.UMLVennDiagram,
            er:            window.UMLERDiagram,
            'folder-tree': window.UMLFolderTreeDiagram,
>>>>>>> Stashed changes
        };
        const R = RENDERERS[type];
        if (!R) return 'Error: Unknown renderer type: ' + type;
        R.render(container, text);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const svgEl = container.querySelector('svg');
        return svgEl ? svgEl.outerHTML : 'Error: No SVG generated';
    }, { type, text });

    await browser.close();

    if (!svg.startsWith('Error')) {
        fs.writeFileSync(cachePath, svg);
    }
    return svg;
}

// Batch mode if called with JSON input
if (require.main === module) {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    (async () => {
        const browser = await chromium.launch();
        const page = await browser.newPage();
        const gitGraphJs = fs.existsSync(GIT_GRAPH_PATH) ? fs.readFileSync(GIT_GRAPH_PATH, 'utf8') : '';
        const bundleJs = fs.readFileSync(BUNDLE_PATH, 'utf8');
<<<<<<< Updated upstream
        await page.setContent(`<html><head><script>${gitGraphJs}</script><script>${bundleJs}</script></head><body><div id="container"></div></body></html>`);
=======
        const gitGraphJs = fs.readFileSync(GITGRAPH_PATH, 'utf8');
        await page.setContent(`<html><head><script>${bundleJs}</script><script>${gitGraphJs}</script></head><body><div id="container"></div></body></html>`);
>>>>>>> Stashed changes

        const results = {};
        for (const [id, diagram] of Object.entries(input)) {
            const { type, text } = diagram;
            const hash = crypto.createHash('md5').update(BUNDLE_HASH + '|' + type + '|' + text).digest('hex');
            const cachePath = path.join(CACHE_DIR, hash + '.svg');

            if (fs.existsSync(cachePath)) {
                results[id] = fs.readFileSync(cachePath, 'utf8');
                continue;
            }

            const svg = await page.evaluate(async ({ type, text }) => {
                const container = document.getElementById('container');
                container.innerHTML = '';
                const RENDERERS = {
<<<<<<< Updated upstream
                    class:      window.UMLClassDiagram,
                    sequence:   window.UMLSequenceDiagram,
                    state:      window.UMLStateDiagram,
                    component:  window.UMLComponentDiagram,
                    deployment: window.UMLDeploymentDiagram,
                    usecase:    window.UMLUseCaseDiagram,
                    activity:   window.UMLActivityDiagram,
                    freeform:   window.UMLFreeformDiagram,
                    gitgraph:   window.UMLGitGraphDiagram,
                    'folder-tree': window.UMLFolderTreeDiagram,
                    venn:       window.UMLVennDiagram,
                    er:         window.UMLERDiagram,
=======
                    class:         window.UMLClassDiagram,
                    sequence:      window.UMLSequenceDiagram,
                    state:         window.UMLStateDiagram,
                    component:     window.UMLComponentDiagram,
                    deployment:    window.UMLDeploymentDiagram,
                    usecase:       window.UMLUseCaseDiagram,
                    activity:      window.UMLActivityDiagram,
                    freeform:      window.UMLFreeformDiagram,
                    gitgraph:      window.UMLGitGraphDiagram,
                    venn:          window.UMLVennDiagram,
                    er:            window.UMLERDiagram,
                    'folder-tree': window.UMLFolderTreeDiagram,
>>>>>>> Stashed changes
                };
                const R = RENDERERS[type];
                if (!R) return 'Error: Unknown renderer type: ' + type;
                R.render(container, text);
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const svgEl = container.querySelector('svg');
                return svgEl ? svgEl.outerHTML : 'Error: No SVG generated';
            }, { type, text });

            if (!svg.startsWith('Error')) {
                fs.writeFileSync(cachePath, svg);
            }
            results[id] = svg;
        }
        await browser.close();
        process.stdout.write(JSON.stringify(results));
    })();
}
