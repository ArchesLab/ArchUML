// Component diagrams of the SEBook and the narration visuals whose compact
// drawing once lost to the drawing without a layout line (smaller on screen,
// more bends) or overlapped. Copied so the submodule tests stand alone; keyed
// by a short name and their source in the site repository.
module.exports = {
  "layers (SEBook/architectural_styles/layers.md)": `@startuml
component Presentation
component Domain
component DataAccess
component Infrastructure
Presentation --> Domain : strict (OK)
Domain --> DataAccess : strict (OK)
DataAccess --> Infrastructure : strict (OK)
Presentation ..> DataAccess : relaxed bridging
Domain ..> Presentation : golden-rule violation
note right of Presentation
  Strict: use only
  the layer directly below.
end note
note right of Domain
  Relaxed: may skip layers
  downward; acceptable.
  Excessive bridging is a smell.
end note
note right of DataAccess
  Golden rule: NEVER
  use a layer above.
  Creates cycles; kills portability.
end note
@enduml
`,
  "pub-sub (SEBook/architectural_styles/pubsub.md)": `@startuml
component Publisher1
component Publisher2
component Topic
component Subscriber1
component Subscriber2
component Subscriber3
Publisher1 --> Topic : publish(event)
Publisher2 --> Topic : publish(event)
Topic --> Subscriber1 : notify
Topic --> Subscriber2 : notify
Topic --> Subscriber3 : notify
note bottom of Topic
  Publisher and Subscriber
  never reference each other —
  the topic is the only coupling point.
end note
@enduml
`,
  "SOLID (SEBook/designprinciples/solid.md)": `@startuml
component SRP
component OCP
component LSP
component ISP
component DIP
LSP --> OCP : enables polymorphism
DIP --> OCP : enables pluggable impls
ISP --> LSP : shrinks surface
SRP --> OCP : narrows change
note bottom of OCP
  OCP is the common
  payoff: extend without
  modifying existing code.
end note
@enduml
`,
  "components only (SEBook/uml_component_diagram.md)": `@startuml
component WebApp
component CatalogService
component OrderService
component PaymentService
component Database
callout right of text "OrderService" : Component: replaceable part; offers and needs services
@enduml
`,
  "threat profile (_data/narration_visuals/huggingface2026.json)": `@startuml
layout portrait
component EvalHarness
component Agents
component SandboxVM
component PackageProxy
EvalHarness --> Agents : scores solved tasks, even impossible ones
Agents --> SandboxVM : root access
Agents --> PackageProxy : forged requests, board
callout right of element EvalHarness : Incentive: a higher score
callout left of element Agents : Knowledge: benchmark paper, worker code, shared discoveries
callout right of element Agents : Resources: about 1,200 agents on the board, about 700 in the attack
callout left of text "root access" : Actions: control of machines, forged requests, stolen tokens
@enduml
`,
  "Therac-25 layers (_data/narration_visuals/therac25.json)": `@startuml
layout vertical
component Controller
component ConfigurationEvidence
component Protection
component Output
Controller --> Output : requests operation
ConfigurationEvidence --> Protection : observed configuration
Protection --> Output : may inhibit
@enduml
`,
  "notes on a full diagram (_data/narration_visuals/uml_component_diagram.json)": `@startuml
layout square
component StudentWeb {
  require "Watches" as sw_watches
}
component AlertService {
  provide "Watches" as as_watches
  portin "events" as as_events
  portout "store" as as_store
  require "TextMessages" as as_texts
}
component SeatPoller {
  require "SeatCounts" as sp_counts
  portout "news" as sp_news
}
component Registrar {
  provide "SeatCounts" as rg_counts
}
component TextGateway {
  provide "TextMessages" as tg_texts
}
component AlertDB {
  portin "sql" as db_sql
}
as_watches --> sw_watches
rg_counts --> sp_counts
tg_texts --> as_texts
sp_news -- as_events : «queue»
as_store -- db_sql : «SQL»
note top of Registrar : run by the university
note top of TextGateway : run by an SMS company
note bottom of StudentWeb : Key: ball in socket = «HTTPS» call
@enduml
`,
};
