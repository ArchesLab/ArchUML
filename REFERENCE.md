# ArchUML Syntax Reference

A complete reference for the `@startuml` syntax supported by the ArchUML renderer (`uml-bundle.js`).

Each section shows the syntax as a code block followed by an HTML rendering div you can embed directly in any page that loads `uml-bundle.js`.

---

## Table of Contents

1. [Setup & Embedding](#setup--embedding)
2. [Global Directives](#global-directives)
3. [Element Highlighting](#element-highlighting)
4. [Class Diagrams](#class-diagrams)
5. [Sequence Diagrams](#sequence-diagrams)
6. [State Machine Diagrams](#state-machine-diagrams)
7. [Component Diagrams](#component-diagrams)
8. [Deployment Diagrams](#deployment-diagrams)
9. [Use Case Diagrams](#use-case-diagrams)
10. [Activity Diagrams](#activity-diagrams)
11. [Freeform Diagrams](#freeform-diagrams)
12. [Git Commit Graphs](#git-commit-graphs)
13. [Notes & Annotations](#notes--annotations)
14. [CSS Theming](#css-theming)
15. [CLI / Node.js API](#cli--nodejs-api)

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

The `@startuml` / `@enduml` markers are optional but recommended for clarity. The last two types intentionally drop the `uml-` prefix since they are not UML — they cover visualisations that no formal UML diagram captures cleanly.

---

## Global Directives

These directives work in any diagram type.

### Layout Direction

```
layout horizontal      ← left-to-right (alias: layout LR, layout left-to-right)
layout vertical        ← top-to-bottom (alias: layout TB, layout top-to-bottom)
layout landscape       ← alias for horizontal
layout portrait        ← alias for vertical
layout compact         ← minimise whitespace
layout square          ← prefer square aspect ratio
layout auto            ← auto-select (default)
layout none            ← disable layout engine
layout shadows on      ← enable drop shadows
layout shadows off     ← disable drop shadows
```

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

Any element declaration may be followed by a `#color` suffix (PlantUML-compatible) to tint that element with a different fill, optionally with a texture keyword to overlay a pattern. The suffix is recognized across all diagram types and pairs with any stereotype or block body.

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
abstract class AbstractName
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

### Message Arrow Types

```
A -> B    Synchronous call    (solid line, filled arrowhead)
A --> B   Response / return   (dashed line, open arrowhead)
A ->> B   Asynchronous        (solid line, open arrowhead)
A ->o B   Lost message        (arrow ends at filled circle)
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
server -->o : timeout
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
server -->o : timeout
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

break [condition]      ← break out of surrounding loop
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
[*] --> InitialState : trigger
FinalState --> [*]
```

**Example:**

```
@startuml
[*] --> Created : Order Placed

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
[*] --> Created : Order Placed

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
[*] --> Validating : submit

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
[*] --> Validating : submit

state Check <<choice>>
Validating --> Check : validate()
Check --> Approved : [valid]
Check --> Rejected : [invalid]
Approved --> [*]
Rejected --> [*]
@enduml
</code></pre>

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

## Deployment Diagrams

### Nodes, Artifacts & Relationships

```
node "NodeName" as alias { ... }     ← execution environment / hardware box
component ComponentName              ← deployed component inside node
artifact "ArtifactName" as alias     ← deployable artifact

A --> B : label          ← dependency / communication path
A ..> B : label          ← dashed dependency
A -- B                   ← plain association
```

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

### Relationships

```
Actor -- UseCase                          ← association (no arrow)
Actor --> UseCase                         ← directed association
UseCase ..> UseCase : <<include>>         ← include (mandatory sub-flow)
UseCase ..> UseCase : <<extend>>          ← extend (optional extension)
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

```
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
```

<pre><code class="language-uml-class">
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
</code></pre>

---

**Example — Java code in note:**

```
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
```

<pre><code class="language-uml-class">
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
  --uml-line:            #444;       /* alternate line color */
  --uml-secondary-line:  #6c7c8d;   /* notes / secondary strokes */
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

// Parse only (returns AST)
window.UMLClassDiagram.parse(specText);

// Render from pre-parsed data
window.UMLClassDiagram.renderFromData(containerEl, parsedData);
```

### Node.js CLI (`uml_render.js`)

Requires [Playwright](https://playwright.dev/). Reads spec from stdin, writes SVG to a file.

```bash
# Usage
echo "<spec>" | node uml_render.js <type> output.svg
cat diagram.uml | node uml_render.js class diagram.svg

# Types: class, sequence, state, component, deployment, usecase, activity
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
| `A ->o B` | Lost message |
| `o-> A` | Found message |

### Combined Fragments (Sequence)

`alt` · `loop` · `opt` · `par` · `break` · `critical` · `ref` · `neg`

### Layout Hints

`layout horizontal` · `layout vertical` · `layout landscape` · `layout portrait` · `layout compact` · `layout square` · `layout auto`

### Note Targets

`note left|right|top|bottom of <Element>`  
`note right of <Class>.<member>`  
`note left|right|over of <Participant>` *(sequence)*
