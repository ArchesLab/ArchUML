# ArchUML Syntax Reference

A complete reference for the `@startuml` syntax supported by the ArchUML renderer (`uml-bundle.js`).

Each section shows the syntax as a code block followed by an HTML rendering div you can embed directly in any page that loads `uml-bundle.js`.

ArchUML supports a subset of UML notation. The visual editor retains incomplete or invalid drafts and reports selected common problems; its diagnostics are not a complete UML validator. Current model limits include multiple provided/required interfaces owned by one port, distinct same-named activity Actions, multiple independently identified activity InitialNodes, and equal short state names in different composites. Source editing does not remove these model limits.

---

## Table of Contents

1. [Setup & Embedding](#setup--embedding)
2. [Global Directives](#global-directives)
3. [Element Highlighting](#element-highlighting)
4. [Class Diagrams](#class-diagrams)
5. [CRC Cards](#crc-cards)
6. [Sequence Diagrams](#sequence-diagrams)
7. [State Machine Diagrams](#state-machine-diagrams)
8. [Component Diagrams](#component-diagrams)
9. [Deployment Diagrams](#deployment-diagrams)
10. [Use Case Diagrams](#use-case-diagrams)
11. [Activity Diagrams](#activity-diagrams)
12. [Freeform Diagrams](#freeform-diagrams)
13. [Git Commit Graphs](#git-commit-graphs)
14. [C4 Model Diagrams](#c4-model-diagrams)
15. [Teaching Callouts](#teaching-callouts)
16. [Notes & Annotations](#notes--annotations)
17. [CSS Theming](#css-theming)
18. [CLI / Node.js API](#cli--nodejs-api)

---

## Setup & Embedding

Include `uml-bundle.js` in your page. Any `<pre><code class="language-uml-*">` block is auto-rendered on load.

```html
<script src="path/to/uml-bundle.js"></script>

<pre><code class="language-uml-class">
@startuml
class Foo
@enduml
</code></pre>
```

Available class names:

| Class | Diagram type |
|---|---|
| `language-uml-class` | Class diagram |
| `language-uml-sequence` | Sequence diagram |
| `language-uml-state` | State machine |
| `language-uml-component` | Component diagram |
| `language-uml-deployment` | Deployment diagram |
| `language-uml-usecase` | Use case diagram |
| `language-uml-activity` | Activity diagram |
| `diagram-freeform` | Freeform box-and-line (non-UML) |
| `diagram-gitgraph` | Git commit graph (non-UML) |
| `diagram-crc` | Class, Responsibility, Collaborator cards (non-UML) |
| `language-c4` | C4 model view, drawn from a YAML design model (non-UML) |

The `@startuml` / `@enduml` markers are optional but recommended for clarity. Non-UML types use the `diagram-` prefix. In SEBook Markdown, a fenced `crc` block also renders CRC cards; an embedding container uses `data-uml-type="crc"`. A fenced `c4` block renders a C4 view (see [C4 Model Diagrams](#c4-model-diagrams)).

---

## Global Directives

These directives are shared across diagram types; individual type sections note any limitations.

### Layout Direction

```
layout horizontal      ← left-to-right (alias: layout LR, layout left-to-right)
layout vertical        ← top-to-bottom (alias: layout TB, layout top-to-bottom)
layout landscape       ← alias for horizontal
layout portrait        ← alias for vertical
layout compact [WxH]   ← largest readable text in the pane (see below)
layout square          ← prefer square aspect ratio
layout auto            ← auto-select (default)
layout none            ← disable layout engine
layout shadows on      ← enable drop shadows
layout shadows off     ← disable drop shadows
```

### Compact Layout

`layout compact` lays the diagram out for the largest readable text in its pane: minimal whitespace, no overlapping boxes or labels, and no crossings or bends added in exchange for the smaller drawing. Text is never shrunk or wrapped; the drawing is made smaller around it, and shaped like the pane, so that it needs less scaling to fit.

```
layout compact           ← pane: the live container, or 900×600 when there is none
layout compact 600x700   ← pane: 600 by 700 CSS pixels
```

Give the size when the drawing is rendered somewhere other than where it is shown, for example at build time for a narrow column. A size that is zero or not of the form `WxH` is ignored, and the container is used.

This applies to class, state, sequence, and component diagrams so far. Other diagram types, deployment included, keep the earlier behaviour of `layout compact`: fixed, smaller gaps. A spec with an `@layout` block (positions saved by the visual editor) keeps its authored geometry; the earlier compact spacing is used there and the pane is ignored. A compact drawing that could not be made free of overlaps carries `data-uml-layout-issues` with their count.

In a sequence diagram, a fragment's guard stays at the head of the operand it guards: beside the operator tab when it fits there inside the frame and clear of every lifeline, otherwise on its own line under the tab. An `else` guard starts the line under its divider. A guard widens its frame only when it is wider than the frame its messages need. As in any layout, a guard that crosses lifelines or activation bars covers them with an opaque backdrop.

In class and component diagrams, packages are part of the compact drawing: their names keep clear of other text, an element inside a package it does not belong to counts as an overlap, and the squeeze keeps room for the frames between elements of different packages. In a component diagram, lines still cross package outlines and pass under their names; in a class diagram, compact or not, a relationship goes around the packages that hold neither of its ends and around package names. Where the automatic layout would put an element inside a package it is not in, or two packages on each other, compact layout places the same diagram package by package instead: each package's members, and its inner packages, are laid out together as one block. Such a drawing can have more bends than the placement it replaces, whose packages overlap. A class diagram is placed package by package without `layout compact` as well. In a component diagram whose default drawing only puts frames on each other, or a frame over a component just outside it, compact also tries that drawing with the frames moved apart: it keeps the default arrangement, and with it the straight lines, where moving apart can end every overlap without changing the order of the components. In state diagrams, transitions into a junction or a join, and out of a junction or a fork, may share their stretch at the pseudostate.

In a component diagram, compact may turn and wrap the chain of components to suit the pane: into rows, read row by row and left to right within a row, or top to bottom, one component per row. The author's arrangement and the one the layout would take for a container of the pane's shape are candidates too, and are kept when they read best. To do this, `layout compact` overrides `left to right direction` and `top to bottom direction`, the direction letter of hidden constraints such as `a -[hidden]r- b`, and `skinparam ranksep` / `nodesep` (which ArchUML ignores anyway). It keeps their order: read row by row, the components come in the order the hidden constraints and the authored direction give them. `layout compact` keeps this meaning when a direction line follows it. A port stays on the side of its component that its connectors arrive from, port names are set at the connector-label size, and each connector label sits by its own connector.

In a component diagram, compact also places the components the way a reader follows the connectors, whichever end each connector is written from: a ball-and-socket assembly runs from the component that requires the interface to the one that provides it, and a plain link, which has no direction, leaves the end with more connectors, so a hub that fans out to many consumers comes first and its consumers follow in one column, their edges facing the hub aligned. That arrangement keeps the authored direction and competes with the others on text size, crossings, and bends. A note on a component inside a package lies inside that package; the package is drawn around it, as around the component's joined interfaces. A note across a package outline counts as an overlap.

In a class diagram whose classes form several unconnected groups, compact packs the groups into rows to suit the pane, each with room for the names set beside its lines. Where neither an inheritance hierarchy nor the author fixes the direction, the groups may also be drawn across: two classes side by side, the name along their line, can suit a narrow pane better than the same two stacked with the name beside it.

Teaching callouts are part of a compact drawing (class, state, sequence, and component diagrams). Their text is set at the diagram's base text size, never below the usual callout size; the layout is judged with its callouts in place and keeps the gaps they sit in; and they are drawn with the diagram rather than afterwards in the page, so they are also present when the diagram is rendered in a worker or a hidden tab. The frame keeps the drawing's compact margin around them. Because the page scales a compact drawing to fit its pane, a callout in a class, state, or component diagram prefers room that does not make the drawing smaller there: space inside the drawing, or beside it in the direction the pane has to spare, over a slightly shorter pointer that would widen or lengthen the drawing along its limiting side.

### Label Direction Cues

On labelled edges, connectors, transitions, messages, and guards, a standalone
`>` or `<` at the start or end of the label is rendered as a small direction
triangle instead of text:

```
A --> B : sends >
A --> B : < receives
(*) --> [approved >] "Ship"
```

The triangle follows the physical source-to-target direction of the rendered
line. The typed cue only requests a triangle; it does not force the triangle to
point left or right.

**Example — explicit landscape layout:**

```
@startuml
layout landscape
class A
class B
class C
A --> B
B --> C
@enduml
```

<pre><code class="language-uml-class">
@startuml
layout landscape
class A
class B
class C
A --> B
B --> C
@enduml
</code></pre>

---

## Element Highlighting

Element declarations in the UML, freeform, Git graph, Venn, and ER renderers may be followed by a `#color` suffix (PlantUML-compatible) to tint that element with a different fill, optionally with a texture keyword to overlay a pattern. CRC cards do not support highlighting suffixes.

```
class Alice #lightblue
class Bob <<service>> #FFEB3B
class Draft #pink hatched               ← color + texture overlay
class Legacy dotted                     ← texture only
abstract class Shape #pink { ... }
state Active #lightgreen crosshatch
[Frontend] #orange
component Backend #lightcoral grid
node WebServer #lightblue striped
actor User #lightgreen
usecase "Login" as UC1 #FFEB3B hatched
participant Alice #lightblue dotted
"Validate" --> "Save" #lightgreen       (activity — tints the target node)
box "Input" as a #lightblue hatched     (freeform)
```

Color formats accepted:

| Form | Example | Notes |
|---|---|---|
| Hex (3-digit) | `#F0A` | Expanded to `#FF00AA` |
| Hex (4-digit) | `#F0AC` | Includes alpha channel |
| Hex (6-digit) | `#FFEB3B` | Standard RGB |
| Hex (8-digit) | `#FFEB3BCC` | RGB + alpha |
| Named | `#lightblue`, `#Red`, `#salmon` | Any CSS color name |

### Texture Overlays

A texture keyword may follow the `#color` suffix (or stand alone) to draw a pattern on top of the fill. The pattern is a semi-transparent SVG overlay, so the underlying color still shows through:

| Keyword | Pattern |
|---|---|
| `hatched` | Diagonal lines |
| `crosshatch` | Diagonal cross-hatching |
| `dotted` | Dot grid |
| `grid` | Fine rectangular grid |
| `striped` | Bold stripes |

```
class Draft dotted                  ← texture only (default fill)
class WIP #FFEB3B hatched           ← color + diagonal lines
state Broken #FF9999 crosshatch
component Legacy #lightcoral grid
```

### Compartment Shading

For class diagrams, when a class has both a header and body compartments the header is rendered with a slightly darker shade of the highlight for visual separation. Classes without members use the exact color supplied. Stroke, text, and default theme colors are not altered, so highlighted elements remain legible under any theme.

**Example — class diagram with mixed highlights:**

```
@startuml
class Alice
class Bob #lightblue
class Charlie #FFEB3B {
  + important()
}
abstract class Shape <<base>> #pink
interface Drawable #99FF99
Alice --> Bob
Bob --> Charlie
Shape <|-- Charlie
Drawable <|.. Bob
@enduml
```

<pre><code class="language-uml-class">
@startuml
class Alice
class Bob #lightblue
class Charlie #FFEB3B {
  + important()
}
abstract class Shape <<base>> #pink
interface Drawable #99FF99
Alice --> Bob
Bob --> Charlie
Shape <|-- Charlie
Drawable <|.. Bob
@enduml
</code></pre>

**Example — mixed textures in a class diagram:**

```
@startuml
class Plain
class Colour #lightblue
class Hatched #lightblue hatched
class Cross #FFEB3B crosshatch
class Dotted dotted
class Grid #99FF99 grid
class Stripe #pink striped { + go() }
Plain --> Colour
Colour --> Hatched
Hatched --> Cross
Cross --> Dotted
Dotted --> Grid
Grid --> Stripe
@enduml
```

<pre><code class="language-uml-class">
@startuml
class Plain
class Colour #lightblue
class Hatched #lightblue hatched
class Cross #FFEB3B crosshatch
class Dotted dotted
class Grid #99FF99 grid
class Stripe #pink striped { + go() }
Plain --> Colour
Colour --> Hatched
Hatched --> Cross
Cross --> Dotted
Dotted --> Grid
Grid --> Stripe
@enduml
</code></pre>

**Example — highlighting states and transitions:**

```
@startuml
[*] --> Idle
state Idle
state Active #lightgreen
state Waiting #FFEB3B
state Broken #FF9999
Idle --> Active : start
Active --> Waiting : pause
Waiting --> Active : resume
Active --> Broken : fail
Broken --> [*]
@enduml
```

<pre><code class="language-uml-state">
@startuml
[*] --> Idle
state Idle
state Active #lightgreen
state Waiting #FFEB3B
state Broken #FF9999
Idle --> Active : start
Active --> Waiting : pause
Waiting --> Active : resume
Active --> Broken : fail
Broken --> [*]
@enduml
</code></pre>

---

## Class Diagrams

### Element Declarations

```
class ClassName
abstract class AbstractName      ← italic name with {abstract} below it (UML 2.5.1, 9.2.4)
interface InterfaceName
enum EnumName
class Name <<StereotypeName>>
class Name #color                 ← highlight (see Element Highlighting)
class Name <<Stereotype>> #color
class Name #color hatched         ← highlight + texture overlay
class Name dotted                 ← texture only
```

**Example:**

```
@startuml
class Vehicle
abstract class Transport
interface Driveable
enum FuelType {
  PETROL
  DIESEL
  ELECTRIC
}
class Car <<singleton>>
@enduml
```

<pre><code class="language-uml-class">
@startuml
class Vehicle
abstract class Transport
interface Driveable
enum FuelType {
  PETROL
  DIESEL
  ELECTRIC
}
class Car <<singleton>>
@enduml
</code></pre>

---

### Members — Visibility & Modifiers

Members are declared inside `{ }` blocks. Visibility prefixes:

```
+  public
-  private
#  protected
~  package
```

Modifiers enclosed in `{ }`:

```
{abstract}   italic rendering
{static}     underlined rendering
```

**Example:**

```
@startuml
abstract class Shape {
  - color: int
  + {abstract} area(): double
  + {static} defaultColor(): int
  # setColor(r: int, g: int, b: int)
}
@enduml
```

<pre><code class="language-uml-class">
@startuml
abstract class Shape {
  - color: int
  + {abstract} area(): double
  + {static} defaultColor(): int
  # setColor(r: int, g: int, b: int)
}
@enduml
</code></pre>

---

### Relationships

All relationship arrows and their meanings:

```
A --|> B         Generalization    (solid line, hollow triangle — A extends B)
A ..|> B         Realization       (dashed line, hollow triangle — A implements B)
A *-- B          Composition       (filled diamond on A side)
A o-- B          Aggregation       (hollow diamond on A side)
A --> B          Navigable assoc.  (open arrowhead toward B)
A <--> B         Bidirectional     (open arrowheads both ends)
A -- B           Association       (plain line, no arrowhead)
A --x B          Non-navigable     (X marker at B)
A x--x B         Non-nav both ends (X markers both ends)
A ..> B          Dependency        (dashed, open arrowhead)
```

Navigability variants for composition/aggregation:

```
A *--> B         Composition + navigable
A *<--> B        Composition + bidirectional
A *--x B         Composition + non-navigable target
A o--> B         Aggregation + navigable
A o<--> B        Aggregation + bidirectional
A o--x B         Aggregation + non-navigable target
```

Association ends can be marked independently: `A x--> B` marks the A end
non-navigable and the B end navigable; `A <--x B` does the reverse. The same
end markers can follow a whole-part diamond, for example `A *x--> B`,
`A *<--x B`, `A ox--x B`, or `A o<-- B`. `x` means explicitly non-navigable;
an unmarked end leaves navigability unspecified.

Recursive associations are supported, including distinct end multiplicities
and a relationship label: `Person "0..1" -- "*" Person : manages`.

**Example:**

```
@startuml
layout portrait
class Client
interface Service
abstract class BaseService
class ConcreteService
class Logger
class Request

Client --> Service : uses
ConcreteService ..|> Service
ConcreteService --|> BaseService
BaseService *-- Logger : owns
Client o-- Request : holds
ConcreteService ..> Request : depends on
@enduml
```

<pre><code class="language-uml-class">
@startuml
layout portrait
class Client
interface Service
abstract class BaseService
class ConcreteService
class Logger
class Request

Client --> Service : uses
ConcreteService ..|> Service
ConcreteService --|> BaseService
BaseService *-- Logger : owns
Client o-- Request : holds
ConcreteService ..> Request : depends on
@enduml
</code></pre>

---

### Multiplicities & Labels

```
A "multiplicity" -- "multiplicity" B : label
A "1" -- "*" B : label
A "1" *-- "1..*" B
A -- B : reads >       label direction cue
A -- B : < writes      leading cue also works
```

Standalone `>` and `<` label cues are rendered as small triangles, not text. The
triangle follows the physical source-to-target direction of the routed
association, even when the cue itself is written as `<`.

**Example:**

```
@startuml
class University {
  + name: String
}
class Department {
  + name: String
}
class Professor {
  + name: String
}
class Student {
  + id: int
}
University "1" *-- "1..*" Department : contains
Department "1" -- "*" Professor : employs
Professor "1" -- "*" Student : advises
@enduml
```

<pre><code class="language-uml-class">
@startuml
class University {
  + name: String
}
class Department {
  + name: String
}
class Professor {
  + name: String
}
class Student {
  + id: int
}
University "1" *-- "1..*" Department : contains
Department "1" -- "*" Professor : employs
Professor "1" -- "*" Student : advises
@enduml
</code></pre>

---

### Enumerations

```
enum EnumName {
  VALUE_ONE
  VALUE_TWO
  VALUE_THREE
}
```

Semicolon-separated single-line form is also accepted:

```
enum Size { SMALL; MEDIUM; LARGE }
```

**Example:**

```
@startuml
enum Color {
  RED
  GREEN
  BLUE
}
enum Size { SMALL; MEDIUM; LARGE }
class Product {
  - name: String
  - color: Color
  - size: Size
}
Product --> Color
Product --> Size
@enduml
```

<pre><code class="language-uml-class">
@startuml
enum Color {
  RED
  GREEN
  BLUE
}
enum Size { SMALL; MEDIUM; LARGE }
class Product {
  - name: String
  - color: Color
  - size: Size
}
Product --> Color
Product --> Size
@enduml
</code></pre>

---

### Stereotypes

```
class Name <<StereotypeName>>
```

**Example:**

```
@startuml
class Singleton <<singleton>> {
  - {static} instance: Singleton
  - Singleton()
  + {static} getInstance(): Singleton
  + operation(): void
}
@enduml
```

<pre><code class="language-uml-class">
@startuml
class Singleton <<singleton>> {
  - {static} instance: Singleton
  - Singleton()
  + {static} getInstance(): Singleton
  + operation(): void
}
@enduml
</code></pre>

---

### Packages

A package groups the classes declared inside its braces, drawn as in component diagrams (UML 2.5.1, 12.2.4): a rectangle with the name in a tab on the left of its top edge, any stereotype above the name, a solid outline, and no fill. Packages sit behind the classes, they nest to any depth, and they enclose their classes at `@pos` positions. A relationship crosses the outline of a package that holds one of its ends and goes around the others. A name may be qualified with `::` and shows as written.

```
package opc::partners { ... }
package opc::partners <<Subsystem>> { ... }
package "Partner Gateways" as partners { ... }
```

**Example:**

```
@startuml
abstract class Provider {
  + {abstract} place(order: SupplierOrder)
}
package opc::partners {
  class SupplierProvider {
    + place(order: SupplierOrder)
  }
  class ShuttleProvider {
    + place(order: SupplierOrder)
  }
}
SupplierProvider --|> Provider
ShuttleProvider --|> Provider
@enduml
```

<pre><code class="language-uml-class">
@startuml
abstract class Provider {
  + {abstract} place(order: SupplierOrder)
}
package opc::partners {
  class SupplierProvider {
    + place(order: SupplierOrder)
  }
  class ShuttleProvider {
    + place(order: SupplierOrder)
  }
}
SupplierProvider --|> Provider
ShuttleProvider --|> Provider
@enduml
</code></pre>

---

### Package Diagrams

A `package` line without braces draws a package that does not show its members (UML 2.5.1, 12.2.4): a large rectangle that holds the name, any stereotype above it, and a small empty tab on the left of its top edge. Such a package is a node, like a class: it takes `@pos`, a `#color`, notes, and relationships, and a relationship ends on its outline. Use dependencies between packages for a package diagram, such as the imports between modules.

```
package infra::http                                 ← a package node; the name shows as written
package "Message broker" as broker <<framework>>    ← display name, identifier, and stereotype
loyalty ..> broker                                  ← dependency between packages
loyalty ..> broker : «use»                          ← with its kind
services ..> infra                                  ← from one package frame to another
```

Packages nest to any depth. A package with braces is a frame around what it declares, and its members may be classes, package nodes, or further frames, so one diagram can show some packages opened and others closed:

```
package infra { package broker; package http }      ← a frame around two package nodes
```

A dependency may also start or end at a package that shows its members: name the package, and the line stops at its frame. Such a line runs straight where the two ends face each other and otherwise takes one corner. A dependency between a package and something that lies inside it or across its outline is not drawn.

The automatic layout keeps packages apart. Where its placement would put an element inside a package it is not in, or two packages on each other, the diagram is placed package by package instead: the members of a package, its inner packages included, are laid out together, and the package takes its place among its siblings as one block, at any depth of nesting. Relationships go around the packages that hold neither of their ends and around every package's name.

**Example — modules and the packages that hold them:**

```
@startuml
package services {
  package website {
    package checkout
    package clients
  }
  package loyalty
}
package infra {
  package broker
  package http
}
checkout ..> clients
clients ..> http
loyalty ..> broker
broker ..> http
@enduml
```

<pre><code class="language-uml-class">
@startuml
package services {
  package website {
    package checkout
    package clients
  }
  package loyalty
}
package infra {
  package broker
  package http
}
checkout ..> clients
clients ..> http
loyalty ..> broker
broker ..> http
@enduml
</code></pre>

---

### Complete Class Diagram Example — Observer Pattern

```
@startuml
layout horizontal
interface Subject {
  + attach(observer: Observer): void
  + detach(observer: Observer): void
  + notifyObservers(): void
}
interface Observer {
  + update(): void
}
class ConcreteSubject {
  - subjectState: String
  + getState(): String
  + setState(value: String): void
}
class ConcreteObserver {
  - subject: ConcreteSubject
  - observerState: String
  + update(): void
}
ConcreteSubject ..|> Subject
ConcreteObserver ..|> Observer
Subject "1" -- "*" Observer : observers
ConcreteObserver --> ConcreteSubject : subject
note right of Subject.notifyObservers
  for each o in observers {
    o.update()
  }
end note
note bottom of ConcreteObserver.update
  observerState =
  subject.getState()
end note
@enduml
```

<pre><code class="language-uml-class">
@startuml
layout horizontal
interface Subject {
  + attach(observer: Observer): void
  + detach(observer: Observer): void
  + notifyObservers(): void
}
interface Observer {
  + update(): void
}
class ConcreteSubject {
  - subjectState: String
  + getState(): String
  + setState(value: String): void
}
class ConcreteObserver {
  - subject: ConcreteSubject
  - observerState: String
  + update(): void
}
ConcreteSubject ..|> Subject
ConcreteObserver ..|> Observer
Subject "1" -- "*" Observer : observers
ConcreteObserver --> ConcreteSubject : subject
note right of Subject.notifyObservers
  for each o in observers {
    o.update()
  }
end note
note bottom of ConcreteObserver.update
  observerState =
  subject.getState()
end note
@enduml
</code></pre>

---

## CRC Cards

CRC stands for **Class, Responsibility, Collaborator**. Use cards to explore what each object's role requires it to know or do, and which other objects it collaborates with. Write responsibilities as short active phrases. This representation follows the card structure introduced by [Beck and Cunningham in *A Laboratory for Teaching Object-Oriented Thinking*](https://c2.com/doc/oopsla89/paper.html).

A card contains a class name and independent **Responsibilities** and **Collaborators** lists. Entries at the same vertical position are not paired. Listing a collaborator does not create another card or draw an arrow; declare its card separately when it belongs in the sketch.

### Syntax

Declare `card Identifier { ... }`, or use `card "Display name" as Identifier { ... }` for a longer title. Inside a card, put each `responsibility: text` or `collaborator: text` entry on its own line. Either list may be empty; omit entries for it. An entry with a prefix still needs nonempty text. Card identifiers must be unique.

```
@startuml
layout auto
card "Shopping cart" as Cart {
  responsibility: Know selected products and quantities
  responsibility: Add a product to the selection
  collaborator: Catalog
}
card Catalog {
  responsibility: Find products available for selection
}
@enduml
```

<pre><code class="diagram-crc">
@startuml
layout auto
card "Shopping cart" as Cart {
  responsibility: Know selected products and quantities
  responsibility: Add a product to the selection
  collaborator: Catalog
}
card Catalog {
  responsibility: Find products available for selection
}
@enduml
</code></pre>

Catalog's empty collaborators compartment means that this sketch records no collaborators for it. A card can also start empty while the design is being explored.

### Rendering and editing

In SEBook, select **CRC cards** in the diagram editor, use a fenced `crc` block in Markdown, or embed `<pre><code class="diagram-crc">...</code></pre>`. The browser API is `UMLCRCDiagram.render(container, source)`; `UMLCRCDiagram.parse(source)` returns the parsed cards. CRC is an ArchUML-specific notation, not a UML diagram type or a claim of PlantUML compatibility.

Layout supports `horizontal`, `vertical`, `square`, `landscape`, `portrait`, `compact`, and `auto`, plus `layout shadows on` / `off`. Card positions can use the editor's shared position metadata. CRC does not support relationship arrows, notes, or element highlighting.

---

## Sequence Diagrams

### Participants

```
participant id: Label        ← box with label
participant id as Label      ← alternate form
actor id: Label              ← stick figure (human actor)
```

Participants used in messages but never declared are created automatically.

**Example:**

```
@startuml
actor user: User
participant browser: WebBrowser
participant server: AppServer
participant db: Database

user -> browser: enter credentials
activate browser
browser -> server: POST /login
activate server
server -> db: findUser(name)
activate db
db --> server: userRecord
deactivate db
server --> browser: 200 OK + token
deactivate server
browser --> user: show dashboard
deactivate browser
@enduml
```

<pre><code class="language-uml-sequence">
@startuml
actor user: User
participant browser: WebBrowser
participant server: AppServer
participant db: Database

user -> browser: enter credentials
activate browser
browser -> server: POST /login
activate server
server -> db: findUser(name)
activate db
db --> server: userRecord
deactivate db
server --> browser: 200 OK + token
deactivate server
browser --> user: show dashboard
deactivate browser
@enduml
</code></pre>

---

### Wrapped Names and Labels

Long lifeline names and message labels make a sequence diagram wide, and a wide drawing is scaled down to fit its
column or printed page, text included. `layout wrap <width>` breaks every lifeline name and message label between
words so that no line is wider than `<width>` units (the default text is 13 units high); a single longer word keeps
a line of its own. Without the directive, names and labels stay on one line. C4 dynamic views use `layout wrap 120`.

```
layout wrap 120
participant coordinator: Registration Coordinator
coordinator -> policy: asks for an eligibility decision from
```

---

### Organization Boxes

Group lifelines by the organization, system, or trust zone that owns them. The syntax follows PlantUML:

```
box "Name" <<stereotype>> #color    ← opens a box; name, stereotype, and color are optional
participant ...                     ← participants and actors declared here belong to the box
end box                             ← closes the box (endbox also works)
```

Each box becomes a lane that runs the full height of the diagram, with its name in a header at the top. UML 2.5.1 defines no grouping of lifelines within an interaction, so ArchUML borrows the ActivityPartition (swimlane) notation of clause 15.6.4: parallel lines with the partition's name in a box at one end. The specification notes that partitions often correspond to organizational units, and it labels a partition outside the modeled organization with the keyword «external» (write `<<external>>`). Neighboring boxes share one dividing line, so a message that crosses a line passes from one owner to another.

- A box keeps its participants together in declaration order. A participant belongs to the first box that declares it, even when an earlier message created it.
- Boxes do not nest: a `box` line closes any open box.
- Without a color, lanes alternate two light tints. With `#color`, the lane takes the color and its header a darker shade; choose a light color so that text keeps its contrast.
- Participants outside every box, such as an initiating actor, stay outside the lanes.

**Example:**

```
@startuml
actor user: Customer
box "Shop"
participant web as : WebApp
participant db as : Database
end box
box "Payment provider" <<external>> #fdf3e1
participant pay as : PaymentGateway
end box
user -> web: checkout()
web -> pay: charge(card)
pay --> web: approved
web -> db: save(order)
web --> user: receipt
@enduml
```

<pre><code class="language-uml-sequence">
@startuml
actor user: Customer
box "Shop"
participant web as : WebApp
participant db as : Database
end box
box "Payment provider" <<external>> #fdf3e1
participant pay as : PaymentGateway
end box
user -> web: checkout()
web -> pay: charge(card)
pay --> web: approved
web -> db: save(order)
web --> user: receipt
@enduml
</code></pre>

---

### Message Arrow Types

```
A -> B    Synchronous call    (solid line, filled arrowhead)
A --> B   Response / return   (dashed line, open arrowhead)
A ->> B   Asynchronous        (solid line, open arrowhead)
A ->o     Lost message        (arrow ends at filled circle)
o-> A     Found message       (starts from filled circle)
A -> A    Self-call           (loop-back arrow)
```

**Example:**

```
@startuml
participant client: Client
participant server: Server
participant pool: ThreadPool

client -> server: request()
activate server
server -> server: validate()
activate server
deactivate server
server ->> pool: submitTask()
activate pool
pool --> server: taskQueued
deactivate pool
server ->o : timeout
o-> client: networkEvent
server --> client: response
deactivate server
@enduml
```

<pre><code class="language-uml-sequence">
@startuml
participant client: Client
participant server: Server
participant pool: ThreadPool

client -> server: request()
activate server
server -> server: validate()
activate server
deactivate server
server ->> pool: submitTask()
activate pool
pool --> server: taskQueued
deactivate pool
server ->o : timeout
o-> client: networkEvent
server --> client: response
deactivate server
@enduml
</code></pre>

---

### Activation & Lifeline Control

```
activate ParticipantId      ← start activation bar
deactivate ParticipantId    ← end activation bar
create ParticipantId        ← show creation message
destroy ParticipantId       ← terminate lifeline with X
```

When `activate` / `deactivate` are omitted, no activation bars are drawn. Add explicit markers when the execution duration matters.

**Example:**

```
@startuml
participant client: Client
participant server: Server
participant db: Database

client -> server: connect()
activate server
server -> db: open()
activate db
db --> server: connection
deactivate db
server --> client: sessionId
deactivate server
client -> server: disconnect()
destroy server
@enduml
```

<pre><code class="language-uml-sequence">
@startuml
participant client: Client
participant server: Server
participant db: Database

client -> server: connect()
activate server
server -> db: open()
activate db
db --> server: connection
deactivate db
server --> client: sessionId
deactivate server
client -> server: disconnect()
destroy server
@enduml
</code></pre>

---

### Combined Fragments

All combined fragment keywords:

```
alt [condition]        ← alternatives (like if/else if/else)
  ...
else [condition]
  ...
end

loop [condition]       ← iteration
  ...
end

opt [condition]        ← optional (zero or one execution)
  ...
end

par [label]            ← parallel (multiple else branches run in parallel)
  ...
else [label]
  ...
end

break [condition]      ← replace the rest of the enclosing interaction fragment
  ...
end

critical [label]       ← atomic region
  ...
end

ref [label]            ← interaction reference
  ...
end

neg [label]            ← forbidden / invalid trace
  ...
end
```

**Example — alt/loop/opt:**

```
@startuml
participant c: Client
participant s: Server
participant cache: Cache
participant db: Database

c -> s: fetchAll()
activate s
loop [for each record]
  alt [cache hit]
    s -> cache: lookup(id)
    activate cache
    cache --> s: cachedData
    deactivate cache
  else [cache miss]
    s -> cache: lookup(id)
    activate cache
    cache --> s: miss
    deactivate cache
    s -> db: query(id)
    activate db
    db --> s: record
    deactivate db
  end
end
opt [user has notifications enabled]
  s -> s: sendNotification()
  activate s
  deactivate s
end
s --> c: results
deactivate s
@enduml
```

<pre><code class="language-uml-sequence">
@startuml
participant c: Client
participant s: Server
participant cache: Cache
participant db: Database

c -> s: fetchAll()
activate s
loop [for each record]
  alt [cache hit]
    s -> cache: lookup(id)
    activate cache
    cache --> s: cachedData
    deactivate cache
  else [cache miss]
    s -> cache: lookup(id)
    activate cache
    cache --> s: miss
    deactivate cache
    s -> db: query(id)
    activate db
    db --> s: record
    deactivate db
  end
end
opt [user has notifications enabled]
  s -> s: sendNotification()
  activate s
  deactivate s
end
s --> c: results
deactivate s
@enduml
</code></pre>

**Example — par, break, critical:**

```
@startuml
participant ui: UI
participant svc: OrderService
participant inv: Inventory
participant pay: Payment

ui -> svc: placeOrder()
activate svc
par [parallel processing]
  svc -> inv: reserveItems()
  activate inv
  inv --> svc: reserved
  deactivate inv
else [charge card]
  svc -> pay: chargeCard()
  activate pay
  pay --> svc: charged
  deactivate pay
end
critical [atomic commit]
  svc -> svc: commitOrder()
  activate svc
  deactivate svc
end
svc --> ui: orderComplete
deactivate svc
@enduml
```

<pre><code class="language-uml-sequence">
@startuml
participant ui: UI
participant svc: OrderService
participant inv: Inventory
participant pay: Payment

ui -> svc: placeOrder()
activate svc
par [parallel processing]
  svc -> inv: reserveItems()
  activate inv
  inv --> svc: reserved
  deactivate inv
else [charge card]
  svc -> pay: chargeCard()
  activate pay
  pay --> svc: charged
  deactivate pay
end
critical [atomic commit]
  svc -> svc: commitOrder()
  activate svc
  deactivate svc
end
svc --> ui: orderComplete
deactivate svc
@enduml
</code></pre>

---

### Create & Destroy Lifecycle

```
create ParticipantId        ← participant appears at this point
server --> NewObj: <<create>>
destroy ParticipantId       ← X drawn on lifeline
```

**Example:**

```
@startuml
participant client: Client
participant server: Server

client -> server: request()
activate server
create Handler
server --> Handler: <<create>>
activate Handler
Handler --> server: result
deactivate Handler
server --> client: response
deactivate server
destroy Handler
@enduml
```

<pre><code class="language-uml-sequence">
@startuml
participant client: Client
participant server: Server

client -> server: request()
activate server
create Handler
server --> Handler: <<create>>
activate Handler
Handler --> server: result
deactivate Handler
server --> client: response
deactivate server
destroy Handler
@enduml
</code></pre>

---

## State Machine Diagrams

### State Declarations & Transitions

```
[*]                         ← initial pseudostate (as source) or final state (as target)
state StateName             ← simple state
state StateName { ... }     ← composite state with sub-states
state Name <<choice>>       ← choice pseudostate (diamond)

StateA --> StateB : event [guard] / action
StateA --> StateB : event
[*] --> InitialState        ← initial transition: no event and no guard (an effect such as `: / setUp()` is allowed)
FinalState --> [*]
```

UML gives the initial pseudostate's transition no trigger or guard: it is taken as soon as the region starts. Put an event on the transition out of the first real state instead.

**Example:**

```
@startuml
[*] --> Created

Created --> Paid : payment_received
Paid --> Shipped : ship_order
Shipped --> Delivered : delivery_confirmed
Delivered --> [*]

Created --> Cancelled : cancel_order [within 24hrs]
Paid --> Refunded : refund_requested / processRefund()
Cancelled --> [*]
Refunded --> [*]
@enduml
```

<pre><code class="language-uml-state">
@startuml
[*] --> Created

Created --> Paid : payment_received
Paid --> Shipped : ship_order
Shipped --> Delivered : delivery_confirmed
Delivered --> [*]

Created --> Cancelled : cancel_order [within 24hrs]
Paid --> Refunded : refund_requested / processRefund()
Cancelled --> [*]
Refunded --> [*]
@enduml
</code></pre>

---

### State Internal Actions

Inside a `state { }` block:

```
entry / action_text       ← executes on state entry
exit / action_text        ← executes on state exit
do / activity_text        ← ongoing activity while in state
```

The equivalent named-row form attaches an action to a state without opening its block: `Connecting : entry / showSpinner()`. Use `exit` or `do` in the same form for exit actions or ongoing activities. Inside a composite state block, a named row can attach an activity to one of its child states.

An **internal transition** handles an event without leaving its state, so no exit or entry action runs. List it in the same compartment, in either form, as `trigger [guard] / effect`:

```
state Waiting {
  entry / notifyCustomer()
  enterPin(code) [pin wrong] / beep()     ← internal transition
}
Waiting : locate / shareLocation()       ← named-row form
```

A row needs its effect slash to count as an internal transition; a row such as `Red : write a failing test` keeps its existing meaning and is not drawn. Draw a self-transition (`Waiting --> Waiting : extendWait`) when the state should be exited and entered again. A self-transition's loop sits on the first face of its state where neither the loop nor its label meets another transition.

**Example:**

```
@startuml
[*] --> Idle

Idle --> AcceptingMoney : selectProduct
AcceptingMoney --> Dispensing : [sufficientFunds] / startDispense()
AcceptingMoney --> Idle : cancel / returnMoney()
Dispensing --> Idle : complete / resetMachine()

state AcceptingMoney {
  entry / displayPrice()
  do / countInsertedCoins()
}

state Dispensing {
  entry / activateMotor()
  exit / stopMotor()
}
@enduml
```

<pre><code class="language-uml-state">
@startuml
[*] --> Idle

Idle --> AcceptingMoney : selectProduct
AcceptingMoney --> Dispensing : [sufficientFunds] / startDispense()
AcceptingMoney --> Idle : cancel / returnMoney()
Dispensing --> Idle : complete / resetMachine()

state AcceptingMoney {
  entry / displayPrice()
  do / countInsertedCoins()
}

state Dispensing {
  entry / activateMotor()
  exit / stopMotor()
}
@enduml
</code></pre>

---

### Composite States

```
state ParentState {
  [*] --> SubState1
  SubState1 --> SubState2 : event
  SubState2 --> [*]
}
```

**Example:**

```
@startuml
[*] --> Active

state Active {
  [*] --> Running
  Running --> Paused : pause()
  Paused --> Running : resume()
}

Active --> Idle : deactivate()
Idle --> Active : activate()
Idle --> [*] : shutdown()
@enduml
```

<pre><code class="language-uml-state">
@startuml
[*] --> Active

state Active {
  [*] --> Running
  Running --> Paused : pause()
  Paused --> Running : resume()
}

Active --> Idle : deactivate()
Idle --> Active : activate()
Idle --> [*] : shutdown()
@enduml
</code></pre>

---

### Choice Pseudostate

```
state Name <<choice>>
StateA --> Name : validate()
Name --> StateB : [valid]
Name --> StateC : [invalid]
```

**Example:**

```
@startuml
[*] --> Validating

state Check <<choice>>
Validating --> Check : validate()
Check --> Approved : [valid]
Check --> Rejected : [invalid]
Approved --> [*]
Rejected --> [*]
@enduml
```

<pre><code class="language-uml-state">
@startuml
[*] --> Validating

state Check <<choice>>
Validating --> Check : validate()
Check --> Approved : [valid]
Check --> Rejected : [invalid]
Approved --> [*]
Rejected --> [*]
@enduml
</code></pre>

### Other Pseudostates

A pseudostate is declared like a choice: `state Name <<kind>>`. The name
identifies it in transitions; the diagram shows only its symbol.

| Declaration | Symbol | Use |
| --- | --- | --- |
| `state Name <<choice>>` | diamond | Branch on guards evaluated when the transition reaches it |
| `state Name <<junction>>` | small filled circle | Merge or split transition paths with static guards |
| `state Name <<history>>` | circled **H** | Re-enter the sub-state its region was last in |
| `state Name <<deepHistory>>` | circled **H\*** | The same, restoring nested sub-states as well |
| `state Name <<fork>>` | bar | Split one transition into concurrent ones |
| `state Name <<join>>` | bar | Merge concurrent transitions into one |
| `state Name <<terminate>>` | cross | End the state machine's own lifetime |

`<<shallowHistory>>` and `<<history*>>` are accepted spellings of the two
history kinds. A fork or join bar lies across the layout direction: horizontal
under `layout vertical`, vertical under `layout horizontal`. Declare a history
pseudostate inside the composite state whose region it remembers.

<pre><code class="language-uml-state">
@startuml
[*] --> Idle
state Split <<fork>>
state Merge <<join>>
state Printing {
  state Resume <<history>>
  [*] --> Feeding
  Feeding --> Inking : sheet ready
}
Idle --> Split : print
Split --> Printing
Split --> Logging
Printing --> Merge : done
Logging --> Merge : written
Merge --> [*]
Paused --> Resume : resume
Printing --> Paused : pause
@enduml
</code></pre>

### State Stereotypes

Any other `<<name>>` on a state declaration is a stereotype, shown in
guillemets above the state's name. It works on simple and composite states.

```
state Ready <<stable>>
state Active <<subsystem>> {
  state Running
}
```

---

## Component Diagrams

Default layout is left-to-right. Supports `layout horizontal` / `layout vertical`.

### Basic Components & Connectors

```
component ComponentName
component ComponentName { ... }
component ComponentName dashed       ← dashed component outline and icon

A --> B : label          ← assembly/usage connector (solid arrow)
A --> B dashed : label   ← assembly/usage connector with dashed line
A ..> B : label          ← dependency (dashed arrow)
A -- B : label           ← plain link
```

**Example:**

```
@startuml
component WebUI
component AppServer
component Database

WebUI --> AppServer : HTTP Requests
AppServer --> Database : SQL Queries
AppServer ..> Logger : uses
@enduml
```

<pre><code class="language-uml-component">
@startuml
component WebUI
component AppServer
component Database

WebUI --> AppServer : HTTP Requests
AppServer --> Database : SQL Queries
AppServer ..> Logger : uses
@enduml
</code></pre>

---

### Ports

Ports are declared inside component `{ }` blocks:

```
portin "PortName" as alias       ← input port (square on left)
portout "PortName" as alias      ← output port (square on right)
portout "PortName" as alias dashed
```

Connect via port aliases:

```
sourcePort --> targetPort : label
sourcePort -down-> targetPort    ← directional hint (up/down/left/right)
```

Standalone labelled ports can be declared at the top level and targeted by connectors:

```
port "External API" as external_api dashed
ComponentA --> external_api dashed : publish
```

**Example:**

```
@startuml
component Frontend {
  portout "httpOut" as f_out
}
component Backend {
  portin "httpIn" as b_in
  portout "dbOut" as b_db
  portout "eventOut" as b_ev
}
component Database {
  portin "dbIn" as db_in
}
component EventBus {
  portin "eventIn" as eb_in
}
f_out --> b_in : REST/JSON
b_db --> db_in : SQL
b_ev --> eb_in : publish
@enduml
```

<pre><code class="language-uml-component">
@startuml
component Frontend {
  portout "httpOut" as f_out
}
component Backend {
  portin "httpIn" as b_in
  portout "dbOut" as b_db
  portout "eventOut" as b_ev
}
component Database {
  portin "dbIn" as db_in
}
component EventBus {
  portin "eventIn" as eb_in
}
f_out --> b_in : REST/JSON
b_db --> db_in : SQL
b_ev --> eb_in : publish
@enduml
</code></pre>

---

### Provided & Required Interfaces (Ball-and-Socket)

```
provide "InterfaceName" as alias    ← lollipop (ball) on component
require "InterfaceName" as alias    ← socket on component

provideAlias --> requireAlias       ← joined assembly (ball fits socket)
provideAlias ..> requireAlias       ← disjoined (standalone symbols)
```

**Example:**

```
@startuml
component Order {
  provide "OrderItems" as o_items
  provide "CustomerInfo" as o_cust
}
component Warehouse {
  require "OrderItems" as w_items
}
component CRM {
  require "CustomerInfo" as crm_cust
}
o_items --> w_items
o_cust --> crm_cust
@enduml
```

<pre><code class="language-uml-component">
@startuml
component Order {
  provide "OrderItems" as o_items
  provide "CustomerInfo" as o_cust
}
component Warehouse {
  require "OrderItems" as w_items
}
component CRM {
  require "CustomerInfo" as crm_cust
}
o_items --> w_items
o_cust --> crm_cust
@enduml
</code></pre>

---

### Display Names & Layout Direction

```
component "Display Name" as alias                ← draws the display name; the alias is the id
component "Display Name" as alias <<keyword>>    ← adds «keyword» above the name (see Stereotypes below)
component "Display Name" as alias <<keyword>> { ... }

layout vertical      ← top to bottom, whatever the shape of the page
layout horizontal    ← left to right, whatever the shape of the page
```

Connectors, ports, and saved layouts refer to a component by its alias; the box shows the
display name. Without a `layout` line, the diagram starts left to right and may turn to fit
the page. With `layout vertical` or `layout horizontal`, the direction is fixed and the components keep
the order in which they are declared: the first is at the top (or on the left), the last at the
bottom (or on the right). In a vertical layout, an assembly between two components that are next
to each other in the column runs straight down between them: the provided and the required
interface sit on the sides of the two boxes that face each other. Every other provided and required
interface sits on the left side of its box, so those assemblies run in one lane beside the column.

**Example:**

```
@startuml
layout vertical
component "Planner Web App" as web <<Container: TypeScript, React>> {
  require "Enrollment API" as web_enroll
}
component "Registration API" as api <<Container: Python, FastAPI>> {
  provide "Enrollment API" as api_enroll
}
api_enroll --> web_enroll : POST /v1/enrollments
@enduml
```

<pre><code class="language-uml-component">
@startuml
layout vertical
component "Planner Web App" as web <<Container: TypeScript, React>> {
  require "Enrollment API" as web_enroll
}
component "Registration API" as api <<Container: Python, FastAPI>> {
  provide "Enrollment API" as api_enroll
}
api_enroll --> web_enroll : POST /v1/enrollments
@enduml
</code></pre>

### Balls and Sockets That Face Their Partners

```
layout ports facing    ← choose the sides of joined balls and sockets after saved positions are applied
```

Without this line, every provided and required interface gets its side from the automatic layout, and a saved
position moves the ball or socket with its box: a consumer moved below its provider keeps its socket on its lower
side, the provider keeps its ball on its upper side, and the line runs around both boxes. With `layout ports facing` on a line of its own, a ball and the socket it
is joined to (an assembly) are turned to face each other at the boxes' final places:

- one box above the other, with a gap between them: the lower side of the upper box and the upper side of the lower one;
- one box beside the other: the right side of the left box and the left side of the right one;
- apart in both directions: the direction with the larger gap, and with equal gaps the direction of `layout vertical`
  or `layout horizontal` (else the direction the automatic layout chose);
- overlapping or touching boxes: the sides the automatic layout chose.

A ball or socket in several assemblies faces the partner of its first one. A port with a saved position of its own,
a port outside every assembly, and a plain port keep their sides. A box is sized for its ports, so it can change
size when its ports change sides; its top-left corner stays on its saved position. Where the two boxes share an x
across a vertical gap, or a height at which both can hold a port across a horizontal gap (below each box's name and
keyword lines), the ball and the socket line up and the line is straight; otherwise the line bends once in the gap.
With less than 46 units between the facing sides, the joined symbol can enter a box by a few units.

**It acts only when a component has a saved position** (an `@layout` entry or an inline `@pos`). A diagram with the
line but without a saved component position draws exactly as it does without the line, and the line changes no
other part of the drawing: not the direction, the layout preference, the boxes, the connectors, or the notes. The UML
visual editor does not write the line: it draws a diagram that has it, and its layout control and position
write-back leave the line alone. C4 interfaces views use it when their saved layout holds a position (see
[Saved layout](#saved-layout) in the C4 section).

```
@startuml
@layout
node "web" x=40 y=320
node "api" x=40 y=40
@endlayout
layout vertical
layout ports facing
component "Planner Web App" as web {
  require "Enrollment API" as web_enroll
}
component "Registration API" as api {
  provide "Enrollment API" as api_enroll
}
api_enroll --> web_enroll : POST /v1/enrollments
@enduml
```

Here the consumer is pinned below its provider, so the ball sits on the provider's lower side and the socket on the
consumer's upper side, and the line runs straight down between them.

---

### Stereotypes

A stereotype names the kind of component (UML 2.5.1, 12.3.4). Write it after the name or alias, before any `#color`, texture, `dashed`, or port block. A `#color` may also come before it.

```
component OPC <<service>>
component "Trip Website" as Website <<web application>> {
  portout "orders" as w_out
}
component Bank <<external>> #lightblue
component Archive #lightblue <<repository>> dashed
component Gateway <<Service, External>>       ← two stereotypes
component Gateway <<Service>> <<External>>    ← the same two
[Ledger] <<repository>>
```

Several stereotypes show as one list in a single pair of guillemets, spelled as written: «Service, External». The keywords are centered in plain face above the centered bold name, and the component icon stays in the corner. A component without a stereotype keeps its one-line header.

A connector may carry a stereotype and a property string (UML 2.5.1, 11.2.4). `<<x>>` in a connector label shows as «x»:

```
ex_out -- l_in : <<subscribe>> {binding = "trip.confirmed"}
```

**Example:**

```
@startuml
component OPC <<service>> {
  portout "trip events" as opc_pub
}
component trips <<topic exchange>> {
  portin "publish" as ex_in
  portout "deliver" as ex_out
}
component Loyalty <<service>> {
  portin "events" as l_in
}
opc_pub -- ex_in : <<publish>>
ex_out -- l_in : <<subscribe>> {binding = "trip.confirmed"}
@enduml
```

<pre><code class="language-uml-component">
@startuml
component OPC <<service>> {
  portout "trip events" as opc_pub
}
component trips <<topic exchange>> {
  portin "publish" as ex_in
  portout "deliver" as ex_out
}
component Loyalty <<service>> {
  portin "events" as l_in
}
opc_pub -- ex_in : <<publish>>
ex_out -- l_in : <<subscribe>> {binding = "trip.confirmed"}
@enduml
</code></pre>

---

### Packages

A UML package groups the components declared inside its braces (UML 2.5.1, 12.2.4). It is drawn as a rectangle with a tab on the left of its top edge; the tab holds the name, with any stereotype above it. Packages nest, have a solid outline, and sit behind the diagram. They are not routing obstacles: connectors and dependencies cross them. A package encloses its members wherever they are placed, including at `@pos` positions.

```
package Headliner { ... }
package "Order Processing Center" as OPC <<Subsystem>> { ... }
package Headliner { component OPC; component Loyalty }    ← one-line block
```

A component belongs to the innermost package it is declared in. A component that is only named by a connector inside a package does not join it. The automatic layout does not keep a package's members together, so it can place another component inside a package. The package then lists that component in its `data-package-overlaps` attribute; move it out with `@pos`, or use `layout compact`, which places such a diagram package by package. A `rectangle { ... }` block is not drawn; its contents are read as top-level declarations.

**Example:**

```
@startuml
package Headliner {
  component Website <<web application>> {
    portout "orders" as w_out
  }
  component OPC <<service>> {
    portin "orders" as opc_in
  }
}
component Bank <<external>>
w_out -- opc_in : HTTPS
OPC ..> Bank : capture payment
@enduml
```

<pre><code class="language-uml-component">
@startuml
package Headliner {
  component Website <<web application>> {
    portout "orders" as w_out
  }
  component OPC <<service>> {
    portin "orders" as opc_in
  }
}
component Bank <<external>>
w_out -- opc_in : HTTPS
OPC ..> Bank : capture payment
@enduml
</code></pre>

---

## Deployment Diagrams

### Nodes, Artifacts & Relationships

```
node "NodeName" as alias <<device>> { ... }  ← hardware node with stereotype
node Runtime <<executionEnvironment>> { ... }
component "ComponentName" as alias   ← component, inside or outside a node
artifact "ArtifactName" as alias     ← artifact rectangle, inside or outside a node

A --> B : label          ← directed communication path (open arrow)
A ..> B : label          ← dependency (dashed line, open arrow)
A -- B : label           ← communication path with no arrow
A --> B dashed : label   ← dashed styling without changing the arrow kind
```

Aliases are stable identifiers; quoted display names are shown in the diagram.
Relationships can target a contained artifact or component directly by its
alias, including a declaration later in the source. Artifacts use the UML
`«artifact»` keyword and remain distinct from component rectangles and node
cubes. For example:

```
node "Web Server" as web <<device>> {
  artifact "app.war" as App
}
artifact "settings.xml" as Config
Config ..> web : <<deploy>>
App ..> Config : reads
```

The parser keeps `nodes` and each node's `components` list of child identifiers
for compatibility. Its `elements` array and `elementMap` expose every typed
element with `name` (identifier), `label`, `kind`, `parentId`, and `stereotype`;
nodes also expose typed `children`. Links preserve `arrow` (`--`, `-->`, or
`..>`) and the independent `dashed` flag.

Node instance notation (name:Type — underlined per UML spec):

```
node instanceName:TypeName { ... }
```

**Example:**

```
@startuml
node WebServer {
  component Nginx
  component AppServer
}
node DatabaseServer {
  component PostgreSQL
}
node ClientDevice {
  component WebBrowser
}

ClientDevice --> WebServer : HTTPS
WebServer --> DatabaseServer : TCP/IP
@enduml
```

<pre><code class="language-uml-deployment">
@startuml
node WebServer {
  component Nginx
  component AppServer
}
node DatabaseServer {
  component PostgreSQL
}
node ClientDevice {
  component WebBrowser
}

ClientDevice --> WebServer : HTTPS
WebServer --> DatabaseServer : TCP/IP
@enduml
</code></pre>

### Nested Nodes

A node may contain other nodes to any depth, for example a device that hosts
an execution environment that hosts a component. Each element's `parentId` is
its innermost enclosing node, and that node lists the element's identifier in
its `components`.

```
node "Campus cloud" as cloud <<executionEnvironment>> {
  node "Kubernetes cluster" as k8s <<executionEnvironment>> {
    node "API pod" as pod <<executionEnvironment>> {
      component "Registration API" as api
    }
  }
}
```

**Example:**

```
@startuml
node "Student laptop" as laptop <<device>> {
  node "Web browser" as browser <<executionEnvironment>> {
    component "Web app" as web
  }
}
node "Campus cloud" as cloud <<executionEnvironment>> {
  node "API pod" as pod <<executionEnvironment>> {
    component "Registration API" as api
  }
}
web --> api : HTTPS
@enduml
```

<pre><code class="language-uml-deployment">
@startuml
node "Student laptop" as laptop <<device>> {
  node "Web browser" as browser <<executionEnvironment>> {
    component "Web app" as web
  }
}
node "Campus cloud" as cloud <<executionEnvironment>> {
  node "API pod" as pod <<executionEnvironment>> {
    component "Registration API" as api
  }
}
web --> api : HTTPS
@enduml
</code></pre>

Every nested node is drawn as a cube inside its parent, below the parent's
name. A node that contains other nodes leaves a wider margin around them, so
connectors can cross into nested nodes, and a taller gap between two of them
when a labelled connector joins their contents, so the label fits beside it.
A connector that starts or ends at a nested node, or at an element inside
one, crosses the borders of the nodes that enclose its endpoints, but never
their names, never runs along their outlines, and goes around every other
node. Its label sits beside it, inside the node that encloses both ends
whenever it fits there, and never covers a name. Other connectors, between
top-level nodes and the components or artifacts directly inside them, keep
the usual placement: their labels stay clear of every node, even when that
puts them further from the connector. The text alternative
names every enclosing level ("API pod inside Kubernetes cluster inside
Campus cloud").

In the visual editor, moving a node moves everything nested in it and keeps
the nesting in the source. The editor does not change nesting: it refuses to
drag an element into or out of a nested node and says why. Edit the source to
move an element to another node.

---

### Deployment with Horizontal Layout

```
@startuml
layout horizontal
node LoadBalancer { component Nginx }
node AppNode1 {
  component UserService
  component OrderService
}
node AppNode2 {
  component PaymentService
  component NotificationService
}
node DataNode {
  component MongoDB
  component Redis
}

LoadBalancer --> AppNode1 : HTTP
LoadBalancer --> AppNode2 : HTTP
AppNode1 --> DataNode : TCP
AppNode2 --> DataNode : TCP
AppNode1 ..> AppNode2 : gRPC
@enduml
```

<pre><code class="language-uml-deployment">
@startuml
layout horizontal
node LoadBalancer { component Nginx }
node AppNode1 {
  component UserService
  component OrderService
}
node AppNode2 {
  component PaymentService
  component NotificationService
}
node DataNode {
  component MongoDB
  component Redis
}

LoadBalancer --> AppNode1 : HTTP
LoadBalancer --> AppNode2 : HTTP
AppNode1 --> DataNode : TCP
AppNode2 --> DataNode : TCP
AppNode1 ..> AppNode2 : gRPC
@enduml
</code></pre>

---

### Node Instance Notation

```
node instanceName:TypeName { ... }
instanceName:TypeName --> other:OtherType : link
```

**Example:**

```
@startuml
node server:BankServer {
  component Transactions
  component AccountMgmt
}
node client:ATMKiosk {
  component ATMSoftware
}

client:ATMKiosk --> server:BankServer : network
@enduml
```

<pre><code class="language-uml-deployment">
@startuml
node server:BankServer {
  component Transactions
  component AccountMgmt
}
node client:ATMKiosk {
  component ATMSoftware
}

client:ATMKiosk --> server:BankServer : network
@enduml
</code></pre>

---

## Use Case Diagrams

### Actors & Use Cases

```
actor ActorName
actor "Actor Label" as alias

usecase "Use Case Name" as UC_ID
usecase "Name"                        ← auto-generates ID from name
```

### System Boundary

```
rectangle "System Name" {
  UC1
  UC2
  alias
}
```

An optional `as SystemID` after the quoted name keeps the boundary's identity
separate from its display label. Inline members separated by semicolons are also
accepted. In the visual editor, select the boundary and use **Use cases in this
system** to include or remove members. Removing membership keeps the use case and
its relationships in the diagram.

### Relationships

```
Actor -- UseCase                          ← association (no arrow)
Actor -- "Use Case Name"                  ← an end may be a quoted name
Actor --> UseCase                         ← directed association
UseCase ..> UseCase : <<include>>         ← include (mandatory sub-flow)
UseCase ..> UseCase : <<extend>>          ← extend (inserted when its condition is true)
Actor --|> Actor                          ← actor generalization
```

**Example:**

```
@startuml
actor User
actor Admin

usecase "Log In" as UC1
usecase "Register Account" as UC2
usecase "Reset Password" as UC3
usecase "Manage Users" as UC4
usecase "Confirm Email" as UC5

rectangle "Auth System" {
  UC1
  UC2
  UC3
  UC4
  UC5
}

User -- UC1
User -- UC2
User -- UC3
User -- UC5
Admin -- UC1
Admin -- UC4
UC3 ..> UC1 : <<extend>>
UC2 ..> UC5 : <<include>>
@enduml
```

<pre><code class="language-uml-usecase">
@startuml
actor User
actor Admin

usecase "Log In" as UC1
usecase "Register Account" as UC2
usecase "Reset Password" as UC3
usecase "Manage Users" as UC4
usecase "Confirm Email" as UC5

rectangle "Auth System" {
  UC1
  UC2
  UC3
  UC4
  UC5
}

User -- UC1
User -- UC2
User -- UC3
User -- UC5
Admin -- UC1
Admin -- UC4
UC3 ..> UC1 : <<extend>>
UC2 ..> UC5 : <<include>>
@enduml
</code></pre>

---

## Activity Diagrams

### Flow Nodes

```
(*)                             ← initial / final node (circle)
"Action Name"                   ← action (quoted string)
"Action Name" --> "Next Action"
(*) --> "First Action"
"Last Action" --> (*)
```

### Decision / Merge

```
if "condition label" then
  --> [yes] "ThenAction"
else
  --> [no] "ElseAction"
endif
```

### Fork / Join (Parallel)

```
fork
  --> "Branch A"
  --> "Branch B"
endfork
```

### Swimlanes

```
|LaneName|        ← assigns all subsequent nodes to this lane
```

**Example — order processing:**

```
@startuml
(*) --> "Receive Order"
"Receive Order" --> "Validate Payment"
if "Payment Valid?" then
  --> [yes] "Process Order"
else
  --> [no] "Reject Order"
endif
"Process Order" --> "Ship Order"
"Ship Order" --> (*)
"Reject Order" --> (*)
@enduml
```

<pre><code class="language-uml-activity">
@startuml
(*) --> "Receive Order"
"Receive Order" --> "Validate Payment"
if "Payment Valid?" then
  --> [yes] "Process Order"
else
  --> [no] "Reject Order"
endif
"Process Order" --> "Ship Order"
"Ship Order" --> (*)
"Reject Order" --> (*)
@enduml
</code></pre>

---

**Example — swimlanes:**

```
@startuml
|Customer|
(*) --> "Place Order"
|Warehouse|
"Place Order" --> "Pick Items"
"Pick Items" --> "Pack"
|Shipping|
"Pack" --> "Ship"
|Customer|
"Ship" --> "Receive"
"Receive" --> (*)
@enduml
```

<pre><code class="language-uml-activity">
@startuml
|Customer|
(*) --> "Place Order"
|Warehouse|
"Place Order" --> "Pick Items"
"Pick Items" --> "Pack"
|Shipping|
"Pack" --> "Ship"
|Customer|
"Ship" --> "Receive"
"Receive" --> (*)
@enduml
</code></pre>

---

## Freeform Diagrams

A deliberately informal diagram type for ad-hoc box-and-arrow visualisations that do **not** fit any formal UML category. Use it for things like memory layouts, tree structures, before/after conceptual pictures, or annotated boxes — the kind of thing you would otherwise draw in ASCII art.

**When to use a different type instead:**

| You are drawing… | Use this instead |
|---|---|
| A process or workflow with steps/decisions | [Activity diagram](#activity-diagrams) |
| A state machine with named states and transitions | [State machine diagram](#state-machine-diagrams) |
| Classes and their relationships | [Class diagram](#class-diagrams) |
| Interactions between actors over time | [Sequence diagram](#sequence-diagrams) |
| A Git commit DAG | [Git commit graph](#git-commit-graphs) |

Freeform is the "none of the above" category. If a formal type fits, prefer it.

### Syntax

```
@startuml
layout horizontal

box "Working Directory" as wd
box "Stash\nWIP: power function" as st
box "Restored" as r

wd --> st : git stash
st --> r  : git stash pop

note bottom of wd : You edit files here
@enduml
```

<pre><code class="diagram-freeform">
@startuml
layout horizontal

box "Working Directory" as wd
box "Stash\nWIP: power function" as st
box "Restored" as r

wd --> st : git stash
st --> r  : git stash pop

note bottom of wd : You edit files here
@enduml
</code></pre>

### Box Shapes

The optional keyword after `box` picks a shape. Default is `rect`.

```
box "Rectangle" as a
box round "Rounded" as b
box pill "Pill / stadium" as c
box circle "Circle" as d
box ellipse "Ellipse" as e
box hex "Hexagon" as f
box note "Dog-eared note" as g
```

<pre><code class="diagram-freeform">
@startuml
layout horizontal
box "Rectangle" as a
box round "Rounded" as b
box pill "Pill" as c
box circle "Circle" as d
box ellipse "Ellipse" as e
box hex "Hexagon" as f
box note "Note" as g
@enduml
</code></pre>

### Multi-Line Labels

Use `\n` inside the quoted label string.

```
box "Line one\nLine two\nLine three" as ml
```

### Edge Operators

| Operator | Meaning |
|---|---|
| `-->` | solid arrow, forward |
| `<--` | solid arrow, reverse |
| `<->` | solid arrow, both directions |
| `--`  | solid line, no arrowhead |
| `..>`, `<..`, `<..>`, `..` | dashed variants |
| `==>`, `<==`, `<==>`, `==` | thick variants |

Edge labels use `:` after the target; quotes around the label are optional.

```
wd --> st : "git stash"
wd --> st : git stash       ← bare label also works
```

### Layered / Stacked Boxes

To reproduce a vertical "stack" of labeled sections (e.g. a memory layout), declare the boxes top-to-bottom and use `layout vertical` (default). Connect them with plain `--` lines so they stay aligned:

<pre><code class="diagram-freeform">
@startuml
layout vertical
box "Stack (grows down)\nlocal variables" as stack
box "Free space" as free
box "Heap (grows up)\nmalloc'd memory" as heap
box "Global / Static" as global
box "Code (Text)" as code

stack -- free
free -- heap
heap -- global
global -- code

note right of stack : High address
note right of code : Low address
@enduml
</code></pre>

### Tree-Style Hierarchies

Trees are boxes connected by `--` edges, laid out horizontally (`layout horizontal`) so parents sit to the left of children:

<pre><code class="diagram-freeform">
@startuml
layout horizontal
box "main-repo/" as root
box ".git/" as dotgit
box ".gitmodules" as gm
box "src/" as src
box "vendor/" as vendor
box "math-utils/" as mu

root -- dotgit
root -- gm
root -- src
root -- vendor
vendor -- mu

note right of gm : Tells Git where to fetch each submodule
@enduml
</code></pre>

---

## Git Commit Graphs

For Git commit DAGs the freeform renderer would be a poor fit — commits, branches, and HEAD have rich semantics that benefit from a dedicated layout engine. The `diagram-gitgraph` type reuses the existing [`GitGraph`](../git-graph.js) renderer (normally driven by live `git log` output) via a compact text DSL.

**Requires** `js/git-graph.js` to be loaded on the page.

### Syntax

```
@startuml
branch main:
  A "Initial commit"
  B "Add helper"
  C "Refactor"

branch feature from B:
  α "Start feature"
  β "Develop"
  γ "Complete"

head main
@enduml
```

Commits are written **oldest → newest**, grouped by branch. `from X` attaches a branch to commit `X`. The renderer reorders them newest-first internally.

### Branching

```
branch <name>[from <commit>]:
  <id> ["message"]
  ...
```

A commit's parent is the preceding commit on the same branch, or the `from` commit for the first one.

### Merges

```
branch main:
  C
  M merge feature "Merge feature into main"

branch feature from B:
  γ
```

`<id> merge <branch>` creates a merge commit whose parents are the previous commit on the current branch and the tip of the named branch.

### HEAD

```
head <branch>                  ← HEAD points at the named branch (default: first branch)
head detached at <commit>      ← detached-HEAD state
```

### Example: Cherry-Pick (Before / After)

Render two side-by-side blocks to show a before/after comparison:

<pre><code class="diagram-gitgraph">
@startuml
branch main:
  A "Initial"
  B "Helper"
  C "Refactor"

branch experimental from B:
  α "Feature start"
  β "In progress"
  γ "Done"

head main
@enduml
</code></pre>

---

## Venn Diagrams

Venn diagrams show how collections of items relate by shared membership. The `diagram-venn` type renders **schematic** (not area-proportional) Venn diagrams for 2–5 sets, using circles for 2–3 sets and carefully tilted ellipses for 4–5 sets so that every possible intersection region is drawn and labeled.

Items are placed into regions by naming the sets whose intersection they belong to. The renderer automatically:

- Picks a distinct color per set from a built-in palette (or uses colors you specify).
- Blends overlapping fills via `mix-blend-mode: multiply`, just like a physical transparency overlay.
- **Chooses readable text color per region** by computing the WCAG relative luminance of the blended fill and picking white or near-black for each label — so items sitting on a dark three-way overlap stay legible without you tuning anything.

### Syntax

```
@startuml
title Optional Title

set SetA
set SetB
set SetC

SetA         : items only in A
SetB         : items only in B
SetA & SetB  : items in A ∩ B
SetA & SetB & SetC : items in A ∩ B ∩ C
outside      : items in none of the sets
@enduml
```

- `set <name>` declares a set. Order of declaration controls color assignment and position.
- A region line is `<set-names> : <comma-separated items>`. Set names can be joined by `&`, `∩`, `+`, or `,` — all mean set intersection.
- `outside`, `none`, or `*` puts items in the universe outside every set.
- Items separate on commas. Escape a literal comma with `\,`.
- Lines starting with `#` (without a colon) or `//` are comments.

### 2-Set Example

<pre><code class="diagram-venn">
@startuml
title Programming Languages

set Compiled
set "Memory Safe"

Compiled               : C, C++
"Memory Safe"          : Python, Ruby, JavaScript
Compiled & "Memory Safe" : Rust, Go, Swift
outside                : Assembly
@enduml
</code></pre>

Quoted set names (`"Memory Safe"`) let you use spaces. Unquoted names must be a single token.

### 3-Set Example

The canonical three-circle Venn — seven regions plus the outside bin.

<pre><code class="diagram-venn">
@startuml
title Web Technologies

set Frontend
set Backend
set Database

Frontend                      : React, Vue
Backend                       : Django, Rails
Database                      : PostgreSQL, Redis
Frontend & Backend            : Next.js, SvelteKit
Backend & Database            : Prisma, SQLAlchemy
Frontend & Database           : PouchDB
Frontend & Backend & Database : Firebase, Supabase
outside                       : Docker
@enduml
</code></pre>

### 4-Set Example

Four sets cannot be drawn with circles while still producing all 16 regions. The renderer uses Venn's construction of **four tilted congruent ellipses** so every one of the 2⁴ = 16 subsets (including every pairwise and the centre four-way overlap) has its own visible region.

<pre><code class="diagram-venn">
@startuml
title Developer Skills

set Frontend
set Backend
set DevOps
set Design

Frontend                                   : React, CSS
Backend                                    : APIs, SQL
DevOps                                     : Docker, K8s
Design                                     : Figma, UX
Frontend & Design                          : UI libs
Backend & DevOps                           : SRE
Frontend & Backend                         : Full-stack
DevOps & Design                            : Design ops
Frontend & Backend & DevOps                : Platform eng
Frontend & Backend & Design                : Product eng
Frontend & DevOps & Design                 : Frontend infra
Backend & DevOps & Design                  : Backend infra
Frontend & Backend & DevOps & Design       : Unicorn
@enduml
</code></pre>

### 5-Set Example

For five sets the renderer uses **Grünbaum's five rotated congruent ellipses** arranged with 72° symmetry — giving all 2⁵ = 32 regions.

<pre><code class="diagram-venn">
@startuml
title Meals

set Breakfast
set Lunch
set Dinner
set Vegetarian
set Quick

Breakfast                             : Pancakes
Lunch                                 : Club sandwich
Dinner                                : Steak
Vegetarian                            : Tofu
Quick                                 : Toast
Breakfast & Quick                     : Cereal
Lunch & Vegetarian                    : Salad
Dinner & Vegetarian                   : Risotto
Breakfast & Vegetarian & Quick        : Yogurt
Lunch & Dinner & Vegetarian           : Veggie bowl
Breakfast & Lunch & Dinner & Vegetarian & Quick : Smoothie
@enduml
</code></pre>

### Custom Colours

Append a color after the set name. Hex codes (`#RRGGBB`, `#RGB`, `#RRGGBBAA`) and CSS named colors both work.

```
set A #e74c3c
set B #3498db
set C lightgreen
```

<pre><code class="diagram-venn">
@startuml
title Custom Palette

set Ocean #0077be
set Forest #228b22
set Desert #edc9af

Ocean            : whale, kelp
Forest           : oak, deer
Desert           : cactus, scorpion
Ocean & Forest   : mangrove
Forest & Desert  : savanna scrub
Ocean & Desert   : coastal dunes
Ocean & Forest & Desert : biosphere
@enduml
</code></pre>

If you declare fewer custom colors than sets, the remaining sets fall back to the default palette. Colours you declare are also respected by the contrast-detection pipeline — overlap regions re-compute their blended luminance and flip text to white or near-black automatically.

### Outside Bin

Items that belong to none of the sets live below the diagram in an "outside" block:

```
outside : item1, item2, item3
none    : alias for outside
*       : alias for outside
```

This is useful to signal "these were considered but don't fit anywhere", e.g. items left out of a taxonomy.

### Notes on Contrast Detection

The automatic text-color picker:

1. Resolves every set fill to a 6-digit hex.
2. For each region, approximates the rendered color as the multiply-blend of the contributing set colors over white.
3. Computes WCAG relative luminance and compares the contrast ratio of white vs. near-black text against that blended color.
4. Picks whichever of the two clears the higher ratio (both typically clear AA 4.5:1 against reasonable palettes).

You don't need to think about this — it just works. But if you pick pathological custom colors (e.g. pure yellow `#ffff00` over white, which stays very light even after multiply), the renderer will still choose near-black over white. There is no manual override for region text color.

### Titles and Layout

`title <text>` adds a centred title above the diagram. `layout shadows on|off` toggles drop shadows. Other `layout` directives are accepted but ignored — the canonical Venn layout has no landscape/portrait orientation.

### Notes on Regions

Attach a callout to any region — including single sets, intersections, and the outside bin — with `note <side> of <region>`:

```
note right of SetA & SetB : full-stack engineers
note left of SetA         : specialists
note top of SetA & SetB & SetC : the triple overlap
note bottom of outside    : dropped items
```

`<side>` is `left`, `right`, `top`, `bottom`, or their synonyms `above` / `below`. The note is pushed outside the diagram in that direction, and a dotted connector runs from the note to the target region's interior. Multiple notes on the same side stack automatically.

Multi-line notes use the block form:

```
note right of SetA & SetB
  Full-stack frameworks
  live in this region.
end note
```

For single-line notes you can also use `\n` as a literal line break inside the text:

```
note left of SetA : First line\nSecond line
```

<pre><code class="diagram-venn">
@startuml
title Developer Skills

set Frontend
set Backend
set DevOps

Frontend                    : React
Backend                     : Django
DevOps                      : Docker
Frontend & Backend          : Next.js
Backend & DevOps            : Platform
Frontend & Backend & DevOps : SRE

note left of Frontend : Pure UI\nwork
note right of Frontend & Backend : Popular full-stack\nframeworks
note top of Frontend & Backend & DevOps : Rare but valuable
note bottom of DevOps
  Infrastructure
  specialists
end note
@enduml
</code></pre>

### Limits

- Fewer than 2 sets: the renderer shows an error message.
- More than 5 sets: not supported — there is no known rotationally-symmetric construction for n ≥ 6 that yields all 2ⁿ regions in a readable way. Split the data into multiple diagrams.
- Unknown set references in a region line (e.g. `Typo : x`) surface a warning banner below the diagram so you notice the typo instead of silently losing items.

---

## ER Diagrams (Chen Notation)

Entity-Relationship diagrams in Peter Chen's classic 1976 notation (with 1989 extensions). Use `diagram-er` to render them.

**Visual conventions** (all automatic from the spec):

| Element | Shape |
|---|---|
| Entity | Rectangle |
| Weak entity | Double rectangle |
| Relationship | Diamond |
| Identifying relationship | Double diamond |
| Attribute | Ellipse, connected by a line |
| Primary key | Attribute name underlined |
| Partial key (weak entity) | Attribute name with dashed underline |
| Derived attribute | Dashed ellipse |
| Multivalued attribute | Double ellipse |
| Cardinality | Label on the connector line |
| Total participation | Double line from entity to relationship |

### Syntax

```
@startuml
title Library System

entity Student {
  # student_id          ' # prefix = primary key (underlined)
  name
  email
  / age                 ' / prefix = derived attribute (dashed ellipse)
  * phones              ' * prefix = multivalued (double ellipse)
}

weak entity Dependent {
  ~ dep_name            ' ~ prefix = partial key (dashed underline)
  dob
}

entity Book {
  # isbn
  title
  * authors
}

relationship Borrows {
  date_out              ' attributes inside a relationship attach to the diamond
  date_due
}

identifying relationship Has

' Connection lines: Entity "cardinality" -- Relationship
'   -- = partial participation, == = total participation (double line)
Student "N"  -- Borrows
Book    "M"  -- Borrows
Student "1"  == Has
Dependent "N" == Has
@enduml
```

### Attribute Markers

The first non-space character on an attribute line selects its kind:

| Prefix | Meaning | Rendering |
|---|---|---|
| `#` | Primary key | Underlined text |
| `~` | Partial key | Dashed-underlined text (for weak entities) |
| `/` | Derived | Dashed ellipse outline |
| `*` | Multivalued | Double ellipse outline |
| *(none)* | Regular attribute | Plain ellipse |

Attributes live inside the `{ ... }` block of an `entity`, `weak entity`, or `relationship`. Relationship-attributes hang off the diamond.

### Connections

A connection line has an **entity**, a **relationship**, and — optionally — a **cardinality** label and **participation** style:

```
Student "N" -- Borrows    ' N:M, partial participation (single line)
Student "1" == Has        ' 1:N, total participation (double line)
Book -- Borrows           ' no cardinality label
Borrows "N" -- Student    ' reverse order also fine
```

Cardinality labels are whatever you write in the quoted string — `1`, `N`, `M`, `(0,N)`, `(1,1)`, etc. — so you can mix Chen's original `1/N/M` notation with Merise-style `(min,max)`.

For ternary or higher-arity relationships, connect three or more entities to the same relationship:

```
relationship Enrolls { grade }
Student  "N" -- Enrolls
Course   "M" -- Enrolls
Semester "1" -- Enrolls
```

### Complete Example — Library System

<pre><code class="diagram-er">
@startuml
title Library System

entity Student {
  # student_id
  name
  email
  / age
  * phones
}

entity Book {
  # isbn
  title
  * authors
}

relationship Borrows {
  date_out
  date_due
}

Student "N" -- Borrows
Book    "M" -- Borrows
@enduml
</code></pre>

### Complete Example — Weak Entity

<pre><code class="diagram-er">
@startuml
title Employee Dependents

entity Employee {
  # emp_id
  name
  salary
}

weak entity Dependent {
  ~ dep_name
  dob
  relationship_type
}

identifying relationship Has

Employee "1" == Has
Dependent "N" == Has
@enduml
</code></pre>

### Layout

The renderer places entities automatically:

- **1 entity** — centred, attributes fan around it.
- **2 entities** — horizontal, relationships between them.
- **3+ entities** — on a circle, relationships at the centroid of their connected entities. When two relationships connect the same pair of entities, the second is offset perpendicular to the first so the diamonds don't overlap.

Attributes radiate outward from their host entity or relationship. Directions pointing at connected partners are "blocked" (± ~25°) so attribute ellipses never sit on a connector line.

### Notes on Style

- Entity and relationship names can be quoted — `entity "Library Branch" { ... }` — for names with spaces.
- Entities referenced on a connection line without being declared are auto-created as plain entities, which is helpful for quick sketches. Declare them explicitly to control their attributes.
- `title <text>` adds a heading above the diagram. `layout shadows on|off` toggles drop shadows; other `layout` directives are ignored.

---

## C4 Model Diagrams

C4 diagrams show the architecture of a software system at four zoom levels: system context, containers, components, and code. ArchUML does not draw them from drawing commands. It reads one **design model** written in YAML and draws any **view** of it, so several diagrams of the same system stay consistent. The model schema is `c4-design/1`; a JSON Schema for editors lives at `c4/schema/1/design.schema.json`.

### Embedding

Write the model in a fenced `c4` block (or `<pre><code class="language-c4">`). The optional comment lines at the top are read before the YAML, in this order:

| Line | Meaning |
|---|---|
| `# caption: text` | The figure caption. It must be the first non-empty line. |
| `# description: text` | An authored text alternative that replaces the generated long description. |
| `# diagnostics: true` | Shows the model's problems as a list after the figure; without it they are not shown. |
| `# panels: syntax` | For an interface description: shows only its syntactic view and its data types without their meanings, for example to ask a question before the semantics are shown. |
| `view: selector` | The view to draw. Without it the model's default view is drawn (the first system's context view, else the landscape). |

In SEBook pages, keep one shared model in `_includes/c4-models/<name>.yml` (it never declares `view:`) and embed a view of it with the `c4-view.html` include, whose parameters are `model` (the file name without `.yml`), `view` (a selector), `caption`, `description`, and `panels`; it writes the fenced block described above. A page that shows C4 figures sets `c4: true` in its front matter so the C4 scripts are loaded with the page; elsewhere the first figure loads them on demand.

A C4 figure never shrinks its labels below the surrounding text. It takes the width of its column when its smallest label stays at least the paragraph size there; otherwise it keeps that size and scrolls sideways inside the figure, which is then a keyboard stop (`data-uml-fit="readable"` on the figure container; other diagram types start fitted to the screen and offer a button to enlarge them). Print fits every figure to the width of the paper.

Every rendered C4 figure keeps its embed text in a `<script type="application/json" data-c4-source>` element inside the figure container, as a JSON string in which each `<` is written as the JSON escape `\u003c`. The drawing's relationship groups also carry a `data-c4-source` attribute (the id of the relationship's source element) and come before that element, so a script that reads the text selects `script[type="application/json"][data-c4-source]` and reads it with `JSON.parse(element.textContent)`; a bare `[data-c4-source]` selector finds a relationship instead.

### View selectors

| Selector | View |
|---|---|
| `landscape` | System landscape |
| `context of <system>` | System context of one software system |
| `containers of <system>` | Containers inside a software system |
| `components of <container>` | Components inside a container |
| `code of <component>` | Classes and interfaces of a component |
| `dynamic <scenario>` | One scenario, step by step |
| `deployment <environment>` | One deployment environment |
| `interfaces of <system, container, or component>` | The interfaces an element provides and requires, with the elements that use them and provide them |
| `interface <interface>` | The description of one interface, as a card of text |

Each selector uses the identifier of the element, scenario, environment, or interface (the YAML key), not its display name; interface identifiers are matched ignoring case.

A selector may end in `with` and one or more annotations separated by commas, such as `containers of shop with interfaces`. The annotation `interfaces` adds the interfaces to a landscape, context, container, component, or dynamic view: each box gains a line "Provides: …" and each relationship a line "via …" naming the interface it uses. `patterns` (also on code views), `styles`, and `tactics` annotate landscape, context, container, and component views in the same way. An annotation a view cannot carry is an error. An annotated view keeps the layout pins of its plain view.

### Minimal model

A model needs `schema`, `name`, and at least one entry under `people` or `systems`. Identifiers are the YAML keys and are unique within the model. Relationships are written once, on the source element, as `collaborators` (the key is the target's identifier, the value is a description, or a map with `description`, `technology`, `connector`). Containers, components, and code elements nest under `containers`, `components`, and `code`. Relationships between nested elements are lifted to the visible level automatically. Responsibilities are `do:`, `know:`, or `decide:` entries. The model below is used for every example in this section.

```yaml
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
```

The remaining fields (`requirements`, `choices`, `decisions`, `quality`, `invariants`, and others) are optional and are covered by the editor and the checks, not by this reference.

### System landscape view: `landscape`

Every person and software system of the model and how they relate, with no system opened up.

<pre><code class="language-c4">
# caption: System landscape view of the Online Shop model
view: landscape
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### System context view: `context of shop`

One software system in the middle, surrounded by the people and systems it interacts with.

<pre><code class="language-c4">
# caption: System context view of the Online Shop model
view: context of shop
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Container view: `containers of shop`

The separately running applications and data stores inside one system.

<pre><code class="language-c4">
# caption: Container view of the Online Shop model
view: containers of shop
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Component view: `components of orders`

The parts inside one container.

<pre><code class="language-c4">
# caption: Component view of the Online Shop model
view: components of orders
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Code view: `code of checkout`

The classes and interfaces that implement one component, drawn as a UML class diagram.

<pre><code class="language-c4">
# caption: Code view of the Online Shop model
view: code of checkout
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Dynamic view: `dynamic checkout`

One scenario as numbered relationships between the same elements; alternatives and loops are listed.

<pre><code class="language-c4">
# caption: Dynamic view of the Online Shop model
view: dynamic checkout
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Deployment view: `deployment production`

Where container and system instances run, as nested deployment nodes.

<pre><code class="language-c4">
# caption: Deployment view of the Online Shop model
view: deployment production
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Interfaces

An element offers an **interface** with `provides`, and a relationship names the interface (or one operation of it) that it calls with `uses`, written `interface-id` or `interface-id.operation-id`. A full interface states its style, technology, and version; each operation has a `syntax` line, its `input` and `output`, and its meaning: `purpose`, `errors`, `examples`, and the responsibilities it `realizes`. A shorthand list such as `provides: ["POST /v1/orders"]` gives the call syntax only. The examples below add two interfaces to the Online Shop model: the Order Service provides the Orders API, which the Web App uses, and the Payment Provider provides the Card Charges API, which the Checkout Coordinator uses.

```yaml
      web:
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS, uses: orders-api.place-order}
      orders:
        provides:
          orders-api:
            name: Orders API
            style: rest
            technology: JSON/HTTPS
            version: 1
            operations:
              place-order:
                syntax: POST /v1/orders
                input:
                  cart_id: {type: string, meaning: the cart the customer checks out}
                output:
                  order_id: {type: string, meaning: the id of the new order}
                  total: {type: integer, meaning: what the customer pays, unit: US cents}
                purpose: When a customer checks out a cart, the service stores the order and charges the customer.
```

A plain view shows an interface only by its technology, on a relationship that names none of its own; the three views below show the interfaces themselves.

### Interfaces view: `interfaces of orders`

One element, the subject of the view, with the interfaces it provides (balls) and requires (sockets), the elements that use them, and the elements that provide them. The automatic layout puts the elements that use the subject's interfaces above it, the subject in the middle, and the elements that provide what it requires below it (with `direction: right`, left to right instead); a saved layout can move every box (see [Saved layout](#saved-layout)), so the order is the automatic layout's only. The view borrows UML's component-diagram notation for provided and required interfaces, while each box keeps its C4 type. A title above the drawing and a legend line and notes below it are text. The legend line names the subject, not a place: "Ball: an interface the element provides. Socket: an interface it requires. Ball in socket: the consumer uses that interface. The subject of this view is Order Service." An element that provides and uses no described interface is drawn alone with a sentence that says so.

<pre><code class="language-c4">
# caption: Interfaces view of the Order Service in the Online Shop model
view: interfaces of orders
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS, uses: orders-api.place-order}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
            id: orders-take
        provides:
          orders-api:
            name: Orders API
            description: Turns a customer's cart into an order.
            style: rest
            technology: JSON/HTTPS
            version: 1
            operations:
              place-order:
                syntax: POST /v1/orders
                input:
                  cart_id: {type: string, meaning: the cart the customer checks out}
                output:
                  order_id: {type: string, meaning: the id of the new order}
                  total: {type: integer, meaning: what the customer pays, unit: US cents}
                purpose: When a customer checks out a cart, the service stores the order and charges the customer.
                errors:
                  empty-cart: {code: 422, when: the cart holds no products; the client asks the customer to add one}
                  payment-refused: {code: 402, when: the card was declined; the client asks for another card}
                examples:
                  - input: {cart_id: c-42}
                    output: {order_id: o-7, total: 2599}
                    note: A cart worth 25.99 USD.
                realizes: [orders-take]
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS, uses: card-charges.charge}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
    provides:
      card-charges:
        name: Card Charges API
        style: rest
        technology: JSON/HTTPS
        version: 2
        operations:
          charge:
            syntax: POST /v2/charges
            input:
              amount: {type: integer, meaning: what to charge, unit: US cents}
              card_token: {type: string, meaning: one-time token for the customer's card}
            output:
              paid: {type: boolean, meaning: whether the money moved}
            purpose: When a shop sends an amount and a card token, the provider charges the card once.
            errors:
              card-declined: {code: 402, when: the card issuer refused the charge; the shop asks for another card}
            examples:
              - input: {amount: 2599, card_token: tok-1}
                output: {paid: true}
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Interface description: `interface orders-api`

One interface as a card of text rather than a drawing: the provider and the clients, a **syntactic view** (each operation's syntax, input, and output), a **semantic view** (purpose, side effects, usage restrictions, errors, examples, and the responsibilities each operation realizes), a data table per type that keeps each field's type in the same row as its meaning and unit, and the shared vocabulary. Missing parts are stated ("Purpose: not stated."). With `# panels: syntax` the card shows the syntactic view and the types only.

<pre><code class="language-c4">
# caption: Interface description of the Orders API in the Online Shop model
view: interface orders-api
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS, uses: orders-api.place-order}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
            id: orders-take
        provides:
          orders-api:
            name: Orders API
            description: Turns a customer's cart into an order.
            style: rest
            technology: JSON/HTTPS
            version: 1
            operations:
              place-order:
                syntax: POST /v1/orders
                input:
                  cart_id: {type: string, meaning: the cart the customer checks out}
                output:
                  order_id: {type: string, meaning: the id of the new order}
                  total: {type: integer, meaning: what the customer pays, unit: US cents}
                purpose: When a customer checks out a cart, the service stores the order and charges the customer.
                errors:
                  empty-cart: {code: 422, when: the cart holds no products; the client asks the customer to add one}
                  payment-refused: {code: 402, when: the card was declined; the client asks for another card}
                examples:
                  - input: {cart_id: c-42}
                    output: {order_id: o-7, total: 2599}
                    note: A cart worth 25.99 USD.
                realizes: [orders-take]
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS, uses: card-charges.charge}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
    provides:
      card-charges:
        name: Card Charges API
        style: rest
        technology: JSON/HTTPS
        version: 2
        operations:
          charge:
            syntax: POST /v2/charges
            input:
              amount: {type: integer, meaning: what to charge, unit: US cents}
              card_token: {type: string, meaning: one-time token for the customer's card}
            output:
              paid: {type: boolean, meaning: whether the money moved}
            purpose: When a shop sends an amount and a card token, the provider charges the card once.
            errors:
              card-declined: {code: 402, when: the card issuer refused the charge; the shop asks for another card}
            examples:
              - input: {amount: 2599, card_token: tok-1}
                output: {paid: true}
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Interfaces in a C4 view: `containers of shop with interfaces`

The container view with the `interfaces` annotation: the boxes name the interfaces they provide, and the relationships name the interface they use.

<pre><code class="language-c4">
# caption: Container view of the Online Shop model with its interfaces
view: containers of shop with interfaces
schema: c4-design/1
name: Online Shop
description: Customers order products and pay for them online.
people:
  customer:
    name: Customer
    description: Browses products and places orders.
    collaborators:
      web: orders products using
systems:
  shop:
    name: Online Shop
    description: Takes orders and arranges payment.
    responsibilities:
      - do: take and store customer orders
    containers:
      web:
        name: Web App
        kind: browser_app
        technology: TypeScript, React
        description: Shows products and the cart.
        responsibilities:
          - do: let customers fill a cart and submit it
        collaborators:
          orders: {description: submits orders to, technology: JSON/HTTPS, uses: orders-api.place-order}
      orders:
        name: Order Service
        technology: Python, FastAPI
        description: Validates, stores, and pays for orders.
        responsibilities:
          - do: validate, store, and pay for each order
            id: orders-take
        provides:
          orders-api:
            name: Orders API
            description: Turns a customer's cart into an order.
            style: rest
            technology: JSON/HTTPS
            version: 1
            operations:
              place-order:
                syntax: POST /v1/orders
                input:
                  cart_id: {type: string, meaning: the cart the customer checks out}
                output:
                  order_id: {type: string, meaning: the id of the new order}
                  total: {type: integer, meaning: what the customer pays, unit: US cents}
                purpose: When a customer checks out a cart, the service stores the order and charges the customer.
                errors:
                  empty-cart: {code: 422, when: the cart holds no products; the client asks the customer to add one}
                  payment-refused: {code: 402, when: the card was declined; the client asks for another card}
                examples:
                  - input: {cart_id: c-42}
                    output: {order_id: o-7, total: 2599}
                    note: A cart worth 25.99 USD.
                realizes: [orders-take]
        components:
          checkout:
            name: Checkout Coordinator
            technology: Python module
            stereotypes: [interfacer]
            description: Runs one checkout from cart to payment.
            responsibilities:
              - do: sequence one checkout from cart to payment
            collaborators:
              db: {description: writes orders to, technology: SQL/TCP}
              payments: {description: requests payment from, technology: HTTPS, uses: card-charges.charge}
            code:
              Checkout: {kind: class, operations: ["+ place(cart): Order"]}
      db:
        name: Order Database
        kind: database
        technology: PostgreSQL 16
        description: Durably stores every order and its status.
        responsibilities:
          - do: durably store every order and its status
  payments:
    name: Payment Provider
    external: true
    description: Charges customer cards for completed orders.
    provides:
      card-charges:
        name: Card Charges API
        style: rest
        technology: JSON/HTTPS
        version: 2
        operations:
          charge:
            syntax: POST /v2/charges
            input:
              amount: {type: integer, meaning: what to charge, unit: US cents}
              card_token: {type: string, meaning: one-time token for the customer's card}
            output:
              paid: {type: boolean, meaning: whether the money moved}
            purpose: When a shop sends an amount and a card token, the provider charges the card once.
            errors:
              card-declined: {code: 402, when: the card issuer refused the charge; the shop asks for another card}
            examples:
              - input: {amount: 2599, card_token: tok-1}
                output: {paid: true}
scenarios:
  checkout:
    title: Check out a cart
    steps:
      - web -> orders: submits the cart to
      - orders -> db: writes orders to
      - orders -> payments: requests payment from
deployment:
  production:
    name: Production
    nodes:
      browser: {name: Web browser, kind: environment, hosts: [web]}
      cloud:
        name: Cloud
        kind: environment
        nodes:
          pod: {name: Order pod, kind: environment, instances: 2, hosts: [orders]}
          database: {name: Managed database, kind: environment, hosts: [db]}
</code></pre>

### Interface checks

The checks for interfaces run once a model describes at least one full interface or names one in `uses`; a model with shorthand lists only is a sketch, and keeps its other checks unchanged. Problems appear in the editor and, with `# diagnostics: true`, under an embedded figure. Errors are references that cannot be resolved or contradict the direction of a contract; warnings are omissions that leave an independently built client guessing; infos have a real chance of a false alarm or matter only across boundaries.

| Rule | Severity | Checks | Rationale | Source |
|---|---|---|---|---|
| `model/interface-provider` | error | Interface used from a relationship that cannot provide it | A reference that contradicts containment or the direction of a contract is invalid, like model/responsibility-owner. | Clements2010; WirfsBrock2003 |
| `model/realizes-owner` | error | Operation realizes a responsibility its provider does not own | A reference that contradicts containment or the direction of a contract is invalid, like model/responsibility-owner. | WirfsBrock2003 |
| `interface/no-syntax` | warning | Operation without a syntax line | The syntactic view must say how to call the operation and what each parameter's type is; a type that is named but not described leaves the client guessing. | Clements2010; lecture L14 |
| `interface/untyped-field` | warning | Field without a type | The syntactic view must say how to call the operation and what each parameter's type is; a type that is named but not described leaves the client guessing. | Clements2010; lecture L14 |
| `interface/undefined-type` | warning | Type used but not described | The syntactic view must say how to call the operation and what each parameter's type is; a type that is named but not described leaves the client guessing. | Clements2010; lecture L14 |
| `interface/no-purpose` | warning | Operation without a purpose | Without a purpose a client cannot tell whether the operation fits its need; the purpose is the advertised responsibility. | Clements2010; WirfsBrock2003 |
| `interface/no-errors` | warning; info for event, stream, library, file, and unset styles | Operation without errors | Remote request/response and command calls always fail somehow (authentication, validation, rate limits, outages), and error handling is part of the semantic view, so a missing error list is a warning for them. An emitted event's risks are delivery guarantees (duplicates, order, loss), which the review prompt and the event frame ask about; in-process and unknown styles may genuinely not fail. Hence info there. | Clements2010; Bass2012 |
| `interface/no-unit` | warning; info for a text field whose name suggests a quantity | Number without a unit | Syntactic interoperability is not enough: independently built systems read a number without a unit or a date without a format differently. The Mars Climate Orbiter's interface specification did state newton-seconds; one side wrote pound-force seconds and no test compared the file with the specification. A stated unit is what makes such a check possible. The exemptions keep false positives low: identifiers state a format, enumerated codes give each value a meaning. The string-name variants are info because names are weak evidence. | MCOMIB1999; Bass2012 |
| `interface/no-format` | warning; info for a text field whose name suggests a date or time | Date or time without a format | Syntactic interoperability is not enough: independently built systems read a number without a unit or a date without a format differently. The Mars Climate Orbiter's interface specification did state newton-seconds; one side wrote pound-force seconds and no test compared the file with the specification. A stated unit is what makes such a check possible. The exemptions keep false positives low: identifiers state a format, enumerated codes give each value a meaning. The string-name variants are info because names are weak evidence. | MCOMIB1999; Bass2012 |
| `interface/example-mismatch` | warning | Example that contradicts its types | The model-level counterpart of validating a document against its schema (lecture L14): a description must not contradict itself. Example values are illustrative, so warning rather than error. | lecture L14 |
| `interface/realizes-internal` | warning | Operation linked to a private obligation | An RDD contract advertises the provider's obligations; its private implementation is not part of it. | WirfsBrock2003; Parnas1972 |
| `interface/in-process-across-boundary` | warning | In-process interface used from another container | A C4 component is not separately deployable; a client in another container reaches it only through a remote interface. Linking it to a library call mixes abstraction levels. | Brown (c4model.com) |
| `interface/requested-not-advertised` | warning | Requested responsibility not advertised by the used operation | In RDD the receiver advertises the responsibility a collaborator requests; a used operation that realizes something else contradicts the stated request. | WirfsBrock2003 |
| `interface/type-spelling` | info | Type written in another language's spelling | Standard type names make descriptions comparable across teams and languages; the other spelling is understood, so this is a suggestion. | — |
| `interface/syntax-only` | info | Shorthand interface used across a boundary | Formalize contracts selectively: boundary-crossing, independently implemented collaborations need semantics; internal sketches may stay short. | WirfsBrock2003 |
| `interface/no-meaning` | info | Field without a meaning | Formalize contracts selectively: boundary-crossing, independently implemented collaborations need semantics; internal sketches may stay short. | WirfsBrock2003 |
| `interface/no-example` | info | Operation without an example | Formalize contracts selectively: boundary-crossing, independently implemented collaborations need semantics; internal sketches may stay short. | WirfsBrock2003 |
| `interface/unrealized` | info | Operation not linked to a responsibility | Connects an operation to the responsibility it serves; absent links are common in early sketches. | WirfsBrock2003 |
| `interface/leaks-implementation` | info | Name that reveals implementation | Expose only what is needed: names of tables, keys, and locks couple clients to the implementation, and operations no client uses must still be kept stable. Word lists produce false positives (a restaurant API has tables), and an unused operation may serve clients outside the model, hence info; `cursor` and `thread` are left out because pagination cursors and discussion threads are ordinary API vocabulary. | Parnas1972; Clements2010 |
| `interface/conflicting-vocabulary` | info | Term with two meanings | A shared vocabulary is a precondition of semantic interoperability; two meanings for one term signal a mismatch, unless the interfaces deliberately differ. | Bass2012; lecture L14 |
| `interface/style-mismatch` | info | Connector and interface style disagree on synchrony | A message interface used through a synchronous call (or the reverse) contradicts the drawn connector; asynchronous REST patterns exist, hence info. | Clements2010 |
| `interface/unspecified-use` | info | Cross-system dependency without an interface | Cross-system dependencies are where interoperability matters; an unused interface may be an entry point or dead weight, so the entry-point case is exempt and the rest is a question, not a verdict. | Bass2012 |
| `interface/unused` | info | Interface nobody uses | Cross-system dependencies are where interoperability matters; an unused interface may be an entry point or dead weight, so the entry-point case is exempt and the rest is a question, not a verdict. | Bass2012 |
| `interface/unused-operation` | info | Operation no client uses | Expose only what is needed: names of tables, keys, and locks couple clients to the implementation, and operations no client uses must still be kept stable. Word lists produce false positives (a restaurant API has tables), and an unused operation may serve clients outside the model, hence info; `cursor` and `thread` are left out because pagination cursors and discussion threads are ordinary API vocabulary. | Parnas1972; Clements2010 |
| `interface/no-version` | info | Cross-system interface without a version | A shared interface changes in every system that uses it, so clients across a system boundary need to know which version they implement; a placeholder without a field cannot be called from the description alone. | Bass2012; Clements2010 |
| `interface/unbound-parameter` | info | Placeholder without an input field | A shared interface changes in every system that uses it, so clients across a system boundary need to know which version they implement; a placeholder without a field cannot be called from the description alone. | Bass2012; Clements2010 |

Sources: Clements2010 is Clements et al., *Documenting Software Architectures: Views and Beyond* (2nd ed.); WirfsBrock2003 is Wirfs-Brock and McKean, *Object Design: Roles, Responsibilities, and Collaborations*; Bass2012 is Bass, Clements, and Kazman, *Software Architecture in Practice* (3rd ed.); Parnas1972 is Parnas, "On the Criteria To Be Used in Decomposing Systems into Modules"; MCOMIB1999 is the Mars Climate Orbiter Mishap Investigation Board's Phase I report; lecture L14 is the course lecture on interfaces.

### Saved layout

A design model keeps where boxes were moved in its top-level `layout` section, which the C4 editor writes. Each
entry is keyed by the view's canonical selector (a custom view by its id). Views in C4 notation (landscape, context,
containers, components) keep a map from element id to the top-left corner of its box; a pinned box keeps its place,
and the boxes it would overlap make room:

```yaml
layout:
  containers of shop:
    web: [40, 120]
    orders: [420, 120]
```

Views drawn in UML notation keep named parts instead, because a UML drawing has bends and a lifeline order besides
positions:

```yaml
layout:
  code of checkout:
    positions:                  # every drawn box
      Checkout: [80, 40]
  deployment production:
    positions:                  # top-level nodes only
      browser: [40, 40]
      cloud: [320, 40]
    routes:
      - {from: web@browser, to: orders@pod, relation: derived, points: [[200, 90], [260, 90], [260, 150], [340, 150]]}
  dynamic checkout:
    lifelines: [web, orders, db, payments]
  interfaces of orders:
    positions:                  # every drawn box
      web: [60, 40]
      orders: [60, 260]
```

| Part | Views | Meaning |
|---|---|---|
| `positions` | code, deployment, interfaces | The top-left corner of a drawn box, by element id (in a deployment view by node id, and only for top-level nodes: what a node contains is laid out inside it and moves with it). |
| `routes` | code, deployment | A line's bends, as `{from, to, relation, points}` with at least two points. In a code view `relation` is `collaborator` (a dependency line; `from` and `to` are the drawn ends). In a deployment view it is `link` (between nodes) or `derived` (between hosted instances, each written `<element>@<node>`). |
| `lifelines` | dynamic | The order of the lifelines, as element ids. The lifelines of one organization box stay together. |

Some things cannot hold a place, and the editor says why when asked to move them: nested deployment nodes and hosted
instances, generalization and realization lines (the renderer routes them as one tree per target), a bend where
two lines of one kind join the same two boxes in one direction, and in an interfaces view a ball, a socket, or the
line between them (the renderer chooses its ends from the places of the boxes). A dynamic view has no positions.

The layout travels inside the ArchUML text the view is drawn from, as an `@layout` block after `@startuml`, so the
editor, an embedded figure, the static prerender, print, and "Copy ArchUML source" draw the same picture. A UML box
with a saved position moves alone: its neighbours do not make room. A stored bend is dropped while drawing when its
line no longer starts and ends on its two boxes (a box moved or grew), and the editor removes it at its next layout
write. An entry that names something the view no longer draws is ignored. An interfaces view that holds a position
also gets the line `layout ports facing` (see
[Balls and Sockets That Face Their Partners](#balls-and-sockets-that-face-their-partners)), so its balls and sockets
face their partners wherever the boxes are; without a saved position it is drawn as before.

---

## Teaching Callouts

Teaching callouts are colored explanation boxes with triangular pointers. They are an authoring overlay, **not UML notation** and not UML's folded-corner `note`. Use them to explain the meaning of a particular symbol, relationship, or label. All seven UML diagram renderers support them.

Load `css/callouts.css` from the ArchUML package alongside `uml-bundle.js`. SEBook already imports it through its shared diagram stylesheet. The Node SVG renderers embed this stylesheet in standalone output.

```text
callout <side> of <target> : <brief explanation>
```

The side (`left`, `right`, `top`, or `bottom`) is a placement preference. The renderer considers nearby positions on all four sides, including empty space within interaction frames and system boundaries. It avoids covering model labels, boxes, and other callouts, leaves a neighbour's nearby approach clear so one wide box cannot starve the next, checks the triangular pointer for collisions, and favors short pointers. When every short path is blocked, it would rather graze a connector than run through a relationship name. Longer pointers widen so they read as the tail of the box rather than as a UML line. Boxes stay compact, and the pointer is painted as part of the same filled outline as the box. It adjusts wrapping to fit nearby space. Callouts do not change model layout or introduce UML relationships. In a `layout compact` class, state, sequence, or component diagram they are placed with the same rules while the layout is chosen, and set at the diagram's base text size; in class, state, and component diagrams a placement that would make the drawing smaller in its pane is also priced (see [Compact Layout](#compact-layout)).

| Target | Example | Meaning |
| --- | --- | --- |
| Visible text | `text "«interface»"` | A whole label, or a substring such as a stereotype, visibility marker, guard, or member name. Exact labels take precedence over substring matches. |
| Repeated text | `text "+" occurrence 2` | The second rendered label containing that text. Occurrences are one-based, in SVG drawing order. |
| Named element | `element Account` | The bounds of an element by its model identifier or alias; visible-name lookup is a fallback. Component ports use `element Service.api`. |
| Relationship/message | `edge 1 end` | The first individually identified rendered route. Choose `start`, `middle` (default), or `end`; lifelines, compartment dividers, and decorative strokes are excluded. Rendering order need not equal source order. |
| Symbol shape | `shape polygon occurrence 1` | A rendered SVG shape, excluding definitions. Useful for hollow triangles on shared inheritance trees, which do not have one route per relationship. Shapes: `rect`, `circle`, `ellipse`, `polygon`, `path`, `line`, `polyline`. |
| Coordinate | `point 120,80` | A fallback for an otherwise unnamed detail, in the final SVG's coordinate system. Prefer semantic targets so annotations follow layout changes. |

Text targets use double-quoted strings with JSON escapes. Explanations are plain text, automatically wrapped, and must fit on one source line. In an HTML attribute, escape `<`, `>` and `&` as usual. An unresolved or malformed target produces an authoring error rather than silently omitting the explanation. A `callout` line inside a multiline UML `note` remains note content.

```text
@startuml
interface Account {
  + balance(): Money
}
class Money
Account --> Money
callout left of text "+" : Public: any client can access this operation.
callout top of text "«interface»" : This keyword identifies an interface contract.
callout bottom of edge 1 end : The open arrow marks the navigable end.
@enduml
```

The default palette is **UCLA dark blue (`#003b5c`) with white text in light mode**, and **UCLA gold (`#ffd100`) with dark blue text in dark mode**. Print always uses the light palette. The UML model and callouts occupy separate SVG groups so the model's dark-mode filter does not invert callout colors.

Stable CSS hooks are `.uml-with-callouts`, `.uml-model-layer`, `.uml-callouts`, `.uml-callout`, `.uml-callout-box`, `.uml-callout-pointer`, and `.uml-callout-bubble`. Override `--uml-callout-fill` and `--uml-callout-text` in CSS when needed; keep their contrast accessible. SEBook includes the explanations in both the image's text alternative and its detailed accessible description.

Keep each explanation focused on what the notation means in this example. Use a few local annotations rather than a large legend. Check dense figures after changes: source-order edits can change `edge`, `shape`, and repeated-text occurrence targets.

---

## Notes & Annotations

Notes are supported in all diagram types.

### Single-Line Note

```
note left of Target : text
note right of Target : text
note top of Target : text
note bottom of Target : text
```

For class diagrams, notes can target specific members:

```
note right of ClassName.memberName : text
```

### Multi-Line Note

```
note right of Target
  Line one
  Line two
end note
```

### Sequence Diagram Notes

```
note left of ParticipantId : text
note right of ParticipantId : text
note over ParticipantId
  Multi-line text
end note
```

**Example — notes in class diagram:**

```
@startuml
class BankAccount {
  + owner: String
  + balance: Number
  + deposit(amount: Number)
  + withdraw(amount: Number)
}
note bottom of BankAccount: {owner->notEmpty() and balance >= 0}
note right of BankAccount.withdraw: Throws `InsufficientFundsException`
@enduml
```

<pre><code class="language-uml-class">
@startuml
class BankAccount {
  + owner: String
  + balance: Number
  + deposit(amount: Number)
  + withdraw(amount: Number)
}
note bottom of BankAccount: {owner->notEmpty() and balance >= 0}
note right of BankAccount.withdraw: Throws `InsufficientFundsException`
@enduml
</code></pre>

---

**Example — notes in sequence diagram:**

```
@startuml
participant c: Client
participant s: Server
participant db: Database

c -> s: authenticate()
activate s
note right of s: Validates JWT token
s -> db: findUser(token)
activate db
note left of db: Lookup by indexed token field
db --> s: userRecord
deactivate db
note over s
  At this point the server has
  verified the user identity.
end note
s --> c: authResult
deactivate s
@enduml
```

<pre><code class="language-uml-sequence">
@startuml
participant c: Client
participant s: Server
participant db: Database

c -> s: authenticate()
activate s
note right of s: Validates JWT token
s -> db: findUser(token)
activate db
note left of db: Lookup by indexed token field
db --> s: userRecord
deactivate db
note over s
  At this point the server has
  verified the user identity.
end note
s --> c: authResult
deactivate s
@enduml
</code></pre>

---

### Note Inline Formatting

Inside any note body:

| Syntax | Effect |
|---|---|
| `` `code` `` | Monospace / inline code |
| `$expr$` | Italic (math-style) |
| ` ```language ` … ` ``` ` | Syntax-highlighted code block |

**Supported syntax-highlight languages:** `python` (or `py`), `java`, `javascript` (or `js`), `cpp` (or `c`)

**Example — Python code in note:**

````
@startuml
class BankAccount {
  + balance: float
  + withdraw(amount: float)
}
note right of BankAccount
  ```python
  def withdraw(self, amount):
      if amount > self.balance:
          raise InsufficientFunds(self.balance)
      self.balance -= amount
  ```
end note
@enduml
````

<pre><code class="language-uml-class">
@startuml
class BankAccount {
  + balance: float
  + withdraw(amount: float)
}
note right of BankAccount
  &#96;&#96;&#96;python
  def withdraw(self, amount):
      if amount > self.balance:
          raise InsufficientFunds(self.balance)
      self.balance -= amount
  &#96;&#96;&#96;
end note
@enduml
</code></pre>

---

**Example — Java code in note:**

````
@startuml
class OrderService {
  + placeOrder(order: Order): boolean
}
note right of OrderService
  ```java
  public boolean placeOrder(Order order) {
      if (order == null)
          throw new IllegalArgumentException();
      return repository.save(order);
  }
  ```
end note
@enduml
````

<pre><code class="language-uml-class">
@startuml
class OrderService {
  + placeOrder(order: Order): boolean
}
note right of OrderService
  &#96;&#96;&#96;java
  public boolean placeOrder(Order order) {
      if (order == null)
          throw new IllegalArgumentException();
      return repository.save(order);
  }
  &#96;&#96;&#96;
end note
@enduml
</code></pre>

---

**Example — mixed inline formatting:**

```
@startuml
class Order {
  + id: int
  + status: String
  + total: double
}
class Customer {
  + name: String
}
Customer "1" -- "*" Order : places
note right of Order
  Status transitions via `updateStatus()`:
  CREATED -> PAID -> SHIPPED
  Total must satisfy $total >= 0$
end note
@enduml
```

<pre><code class="language-uml-class">
@startuml
class Order {
  + id: int
  + status: String
  + total: double
}
class Customer {
  + name: String
}
Customer "1" -- "*" Order : places
note right of Order
  Status transitions via `updateStatus()`:
  CREATED -> PAID -> SHIPPED
  Total must satisfy $total >= 0$
end note
@enduml
</code></pre>

---

## CSS Theming

Override any of the following CSS custom properties to theme diagrams globally:

```css
:root {
  --uml-stroke:          #4060a0;   /* line / border color */
  --uml-text:            #222;       /* primary text */
  --uml-fill:            #fdfcf8;   /* default element fill */
  --uml-header-fill:     #dbe8f8;   /* class header / title bar fill */
  --uml-line:            #000;       /* relationship lines */
  --uml-secondary-line:  #657484;   /* notes / secondary strokes */
  --uml-secondary-fill:  #eef4fa;   /* note background */
  --uml-label-fill:      rgba(255,255,255,0.94);   /* relationship label bg */
  --uml-label-stroke:    rgba(64,96,160,0.18);     /* relationship label border */
}
```

**Example — dark theme:**

```css
:root {
  --uml-stroke:         #7aa2f7;
  --uml-text:           #c0caf5;
  --uml-fill:           #1a1b26;
  --uml-header-fill:    #24283b;
  --uml-secondary-fill: #16161e;
  --uml-label-fill:     rgba(26,27,38,0.94);
}
```

---

## CLI / Node.js API

### Browser API

```javascript
// Render into a container element
window.UMLClassDiagram.render(containerEl, specText);
window.UMLSequenceDiagram.render(containerEl, specText);
window.UMLStateDiagram.render(containerEl, specText);
window.UMLComponentDiagram.render(containerEl, specText);
window.UMLDeploymentDiagram.render(containerEl, specText);
window.UMLUseCaseDiagram.render(containerEl, specText);
window.UMLActivityDiagram.render(containerEl, specText);
window.UMLCRCDiagram.render(containerEl, specText);

// Parse only (returns AST)
window.UMLClassDiagram.parse(specText);

// Render from pre-parsed data
window.UMLClassDiagram.renderFromData(containerEl, parsedData);
```

### Drawing over a rendered diagram

An editor or an overlay may add its own elements inside a rendered SVG: hit targets, an accessible listbox, menus,
buttons, bend numbers. The bundle's route helpers must not take those for parts of the diagram. Put them in a group
that carries the attribute `data-layout-ignore` (any value, also empty), or in a group with the class
`uml-pg-edit-layer`, which the UML visual editor's hit layer uses:

```html
<g data-layout-ignore role="listbox" aria-label="Elements in this view"> … </g>
```

Everything inside such a group, and the group itself, is outside the layout, as `<defs>` is:

- `UMLShared.collectEditableRoutes(svg)` lists no line or path inside it, so the ordinal ids of unnamed lines
  (`edge-0`, `edge-1`, …) do not shift when an overlay draws a path;
- no rectangle inside it is an obstacle when a route is checked or drawn;
- moving a bend or the end of a route moves the route's own arrowheads and labels, but no element inside the group,
  even one tagged with the route's id or lying at its end.

Nothing else changes: a drawing that has no such group is drawn and edited as before.

**Stored routes that no longer join their boxes.** By default `UMLShared.applyLayoutRoutes` applies every stored
route of an `@layout` block. A caller that would rather drop a stored route whose first point no longer lies on the
border of its source box, or whose last point no longer lies on the border of its target box (because a box moved
or changed size after the route was saved), draws inside the opt-in:

```javascript
const dropped = UMLShared.renderSkippingDetachedRoutes(() => {
  UMLClassDiagram.render(containerEl, specText);
});
// dropped: the ids of the stored routes left out, such as ['rel:7']
```

While `draw` runs, such a route is left out and its line keeps the route the renderer drew; the call returns the ids
it left out. "On the border" allows 1.5 units, and the points are measured as the route's element will hold them.
The container must be in the document, because the check measures the drawing. C4 views drawn in UML notation use it,
so a stale bend costs no second drawing.

### Node.js CLI (`uml_render.js`)

Requires [Playwright](https://playwright.dev/). Reads spec from stdin, writes SVG to a file.

```bash
# Usage
echo "<spec>" | node uml_render.js <type> output.svg
cat diagram.uml | node uml_render.js class diagram.svg

# Types: class, sequence, state, component, deployment, usecase, activity, crc
```

**Example:**

```bash
cat <<'EOF' | node uml_render.js class observer.svg
@startuml
interface Observer { + update(): void }
class ConcreteObserver { + update(): void }
ConcreteObserver ..|> Observer
@enduml
EOF
```

### Batch Rendering (`uml_to_svg.js`)

Renders multiple diagrams in one Playwright session with MD5-based caching (stored in `.uml_cache/`).

```bash
node uml_to_svg.js < input.json > output.json
```

Input JSON format:

```json
{
  "diagram1": { "type": "class",    "text": "@startuml\n...\n@enduml" },
  "diagram2": { "type": "sequence", "text": "@startuml\n...\n@enduml" }
}
```

Output JSON format:

```json
{
  "diagram1": "<svg>...</svg>",
  "diagram2": "<svg>...</svg>"
}
```

---

## Quick Reference Card

### Relationship Arrows (Class)

| Arrow | Meaning |
|---|---|
| `A --|> B` | Generalization (extends) |
| `A ..|> B` | Realization (implements) |
| `A *-- B` | Composition |
| `A o-- B` | Aggregation |
| `A --> B` | Navigable association |
| `A <--> B` | Bidirectional association |
| `A -- B` | Plain association |
| `A --x B` | Non-navigable association |
| `A ..> B` | Dependency |

### Message Arrows (Sequence)

| Arrow | Meaning |
|---|---|
| `A -> B` | Synchronous call |
| `A --> B` | Return / response |
| `A ->> B` | Asynchronous |
| `A ->o` | Lost message |
| `o-> A` | Found message |

### Combined Fragments (Sequence)

`alt` · `loop` · `opt` · `par` · `break` · `critical` · `ref` · `neg`

### Stereotypes and Packages (Class, Component)

`component Name <<Kind>>` · `component Name <<A, B>>` · `A -- B : <<kind>> {property = "value"}` · `package Name { … }` · `package "Display Name" as Id <<Kind>> { … }` · `package Name` *(class diagrams: a package node)*

### Layout Hints

`layout horizontal` · `layout vertical` · `layout landscape` · `layout portrait` · `layout compact [WxH]` · `layout square` · `layout auto`

### Note Targets

`note left|right|top|bottom of <Element>`  
`note right of <Class>.<member>`  
`note left|right|over of <Participant>` *(sequence)*
