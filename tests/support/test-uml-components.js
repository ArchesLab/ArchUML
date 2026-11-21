// The 16 component diagrams of test-uml.html (site repository), copied so the
// submodule tests stand alone. Keyed by their heading there.
module.exports = {
  "36. Client-Server (from Lecture)": `@startuml
component Client
component LibraryServer

Client --> LibraryServer : GET Book
Client --> LibraryServer : POST Book
@enduml
`,
  "24. Three-Tier Architecture": `@startuml
component WebUI
component AppServer
component Database

WebUI --> AppServer : HTTP Requests
AppServer --> Database : SQL Queries
AppServer ..> Logger : uses
@enduml
`,
  "25. Microservices": `@startuml
component APIGateway
component UserService
component OrderService
component PaymentService
component NotificationService

APIGateway --> UserService : /api/users
APIGateway --> OrderService : /api/orders
OrderService --> PaymentService : processPayment
OrderService ..> NotificationService : sendConfirmation
PaymentService ..> NotificationService : sendReceipt
@enduml
`,
  "26. Frontend-Backend-Database (directional ports)": `@startuml
component Frontend {
  portout "httpOut" as f_out
}
component Backend {
  portin "httpIn" as b_in
  portout "dbOut" as b_dbout
  portout "eventOut" as b_eventout
}
component Database {
  portin "dbIn" as db_in
}
component EventBus {
  portin "eventIn" as eb_in
}
f_out --> b_in : HTTP / JSON
b_dbout --> db_in : SQL
b_eventout --> eb_in : publish
@enduml
`,
  "27. Microservice API Gateway (Port-to-Port)": `@startuml
component Gateway {
  portout "out1" as g_out1
  portout "out2" as g_out2
}
component Auth {
  portin "in" as a_in
  portout "out1" as a_out1
  portout "out2" as a_out2
}
component Users {
  portin "/users" as u_p1
  portin "/users" as u_p2
  portin "/users/unsubscribe/{userId}" as u_p3
}
component Clubs {
  portin "/clubs" as c_p1
  portin "/clubs/event-reference/{eventId}" as c_p2
  portin "/clubs/roles/{clubId}/{userId}" as c_p3
  portout "out1" as c_out1
}
component Events {
  portin "/events" as e_p1
  portin "/events/template-data/{templateId}" as e_p2
  portout "out1" as e_out1
  portout "out2" as e_out2
}
component Notifications {
  portin "/notifications/event-update" as n_p1
  portout "out1" as n_out1
  portout "out2" as n_out2
}

g_out1 --> c_p1 : POST
g_out2 --> u_p2 : POST
a_out1 --> u_p1 : GET
a_out2 --> c_p3 : GET
c_out1 --> e_p1 : GET
e_out1 --> c_p2 : GET
e_out2 --> n_p1 : POST
n_out1 --> e_p2 : GET
n_out2 --> u_p3 : POST
@enduml
`,
  "27b. Component API Back-Edges with Shared Ports": `@startuml
layout landscape
!theme plain
left to right direction
skinparam componentStyle uml2
skinparam nodesep 20
skinparam ranksep 150

' Hidden constraints keep the intended service sequence without rendering edges.
gateway -[hidden]r- auth
auth -[hidden]r- users
users -[hidden]r- clubs
clubs -[hidden]r- events
events -[hidden]r- notifications

component users {
  portin "/users" as users_port
}
component clubs {
  portin "/clubs" as clubs_port
}
component events {
  portin "/events" as events_port
}
component notifications {
  portin "/notifications" as notifications_port
}

notifications --> users_port : "patch /users/unsubscribe/{userId}"
notifications --> events_port : "get /events/template-data/{templateId}"
auth --> clubs_port : "get /clubs/roles/{clubId}/{userId}"
auth --> users_port : "post /users"
gateway --> users_port : "get /users"
gateway --> clubs_port : "get /clubs"
clubs --> events_port : "post /events"
events --> notifications_port : "post /notifications/event-update"
events --> clubs_port : "delete /clubs/event-reference/{eventId}"
@enduml
`,
  "27c. Component Dashed Visual Style": `@startuml
component Source dashed {
  portout "events" as events dashed
}
component Worker {
  portin "jobs" as jobs
  portout "status" as status dashed
}
component Monitor
port "External Topic" as external_topic dashed

events --> jobs dashed : publish
status --> external_topic dashed : report
Worker --> Monitor dashed : observe
@enduml
`,
  "27d. Standalone Labelled Ports": `@startuml
component Publisher {
  portout "out" as pub_out
}
component Subscriber {
  portin "in" as sub_in
}
port "Kafka Topic" as topic dashed

pub_out --> topic dashed : produce
topic --> sub_in dashed : consume
@enduml
`,
  "28. Joined Assembly Interfaces (Ball-and-Socket)": `@startuml
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
`,
  "29. Disjoined Interfaces (Standalone Lollipop and Socket)": `@startuml
component WebApp {
  provide "UserAPI" as wa_api
  require "DataStore" as wa_ds
}
component Database {
  provide "DataStore" as db_ds
}
component MobileApp {
  require "UserAPI" as ma_api
}
wa_api ..> ma_api : REST
db_ds ..> wa_ds : JDBC
@enduml
`,
  "40. Component Diagram with Note": `@startuml
component Frontend
component API
component Database

Frontend --> API : REST
API --> Database : SQL
note right of API
  All requests are authenticated
  via JWT middleware before
  reaching the handler.
end note
@enduml
`,
  "Unheaded: Client calls Gateway with a direction cue": `@startuml
component Client
component Gateway
Client --> Gateway : call <
@enduml
`,
  "64. Component Port Crossing Test": `component Notifications {
  portout "out1" as n_out1
  portout "out2" as n_out2
  portin "/notifications/event-update" as n_evup
}
component Templates {
  portin "ts/template-data/{templateId}" as t_templ
  portout "out2" as t_out2
}
n_out1 --> t_templ : GET
t_out2 --> n_evup : POST
`,
  "65. Component Port Non-Crossing Test": `component Backend {
  portin "httpIn" as b_in
  portout "dbOut" as b_db
  portout "eventOut" as b_ev
}
component Database {
  portin "dbIn" as d_in
}
component EventBus {
  portin "eventIn" as e_in
}
b_db --> d_in : SQL
b_ev --> e_in : publish
`,
  "72. Element Colors — Component Diagram": `@startuml
[Frontend] #lightblue
[API Gateway] #FFEB3B
[Auth Service] #lightgreen
[Data Service] #lightcoral
[Database] #pink
[Frontend] --> [API Gateway]
[API Gateway] --> [Auth Service]
[API Gateway] --> [Data Service]
[Data Service] --> [Database]
@enduml
`,
  "75. Texture Overlays — Component Diagram": `@startuml
[Legacy Module] #lightcoral hatched
[Deprecated API] dotted
[Active Service] #lightblue grid
[New Module] #99FF99
[Legacy Module] --> [Active Service]
[Deprecated API] --> [Active Service]
[Active Service] --> [New Module]
@enduml
`,
};
