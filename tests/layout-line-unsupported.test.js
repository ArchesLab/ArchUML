// A layout preference line (`layout compact 600x700`, `layout portrait`, …)
// means nothing to the renderers that have no layout modes. For them the
// line must change nothing: the drawing with it is byte-identical to the
// drawing without it. The folder tree once drew the line as a file.
// (Freeform diagrams have a compact mode of their own; the git graph draws
// with a site script outside this repository. Neither is listed.)

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

const BUNDLE = path.join(__dirname, '../uml-bundle.js');

// Short specs from test-uml.html (site repository), one per renderer.
const SPECS = {
  UMLFolderTreeDiagram: `@startuml
project-root/
  src/ #lightblue
    components/ #lightblue hatched
      Button.tsx #99FF99
      Modal.tsx #99FF99 dotted
    utils/
      auth.ts #FFEB3B
      helpers.ts
  tests/ #lightcoral grid
    Button.test.tsx
  README.md
  package.json #FFEB3B
@enduml`,
  UMLVennDiagram: `@startuml
title Programming Languages
set Compiled
set "Memory Safe"
Compiled                 : C, C++
"Memory Safe"            : Python, Ruby, JavaScript
Compiled & "Memory Safe" : Rust, Go, Swift
outside                  : Assembly
@enduml`,
  UMLERDiagram: `@startuml
title Library System
entity Student {
  # student_id
  name
}
entity Book {
  # isbn
  title
}
relationship Borrows {
  date_out
}
Student "N" -- Borrows
Book "M" -- Borrows
@enduml`,
  UMLCRCDiagram: `@startuml
card "Shopping cart" as Cart {
  responsibility: Know selected products
  collaborator: Catalog
}
@enduml`,
};

const LAYOUT_LINES = ['layout compact 600x700', 'layout compact', 'layout portrait'];

function withLine(spec, line) {
  return spec.replace('@startuml\n', `@startuml\n${line}\n`);
}

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

async function render(renderer, source) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  try {
    await page.setContent('<html><head><title>Layout line</title></head><body><div id="diagram" style="width:600px;height:700px"></div></body></html>');
    await page.addScriptTag({ path: BUNDLE });
    return await page.evaluate(([name, src]) => {
      const container = document.getElementById('diagram');
      window[name].render(container, src);
      return container.innerHTML;
    }, [renderer, source]);
  } finally {
    await page.close();
  }
}

for (const [renderer, spec] of Object.entries(SPECS)) {
  for (const line of LAYOUT_LINES) {
    test(`${renderer}: a \`${line}\` line changes the drawing`, async () => {
      const [plain, withLayoutLine] = await Promise.all([render(renderer, spec), render(renderer, withLine(spec, line))]);
      assert.match(plain, /<svg/);
      assert.equal(withLayoutLine, plain);
    });
  }
}
