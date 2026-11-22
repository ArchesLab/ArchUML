'use strict';

// Class and component diagrams with packages, one per package shape, each
// with the package structure a reader expects: the elements inside each
// package (nested members included) and which package encloses which.

const CLASS = {
  'two sibling packages': {
    body: `package orders {
  class Order {
    -id: int
    +total(): double
  }
  class LineItem {
    -qty: int
  }
}
package billing <<subsystem>> {
  class Invoice {
    -number: String
  }
  class Payment {
    -amount: double
    +authorize()
  }
}
class Customer {
  -name: String
}
Customer "1" --> "0..*" Order : places
Order "1" *-- "1..*" LineItem : contains
Order --> Invoice : generates
Invoice --> Payment : settledBy
Customer ..> Payment : pays`,
    members: { orders: ['Order', 'LineItem'], billing: ['Invoice', 'Payment'] },
  },
  'a package and loose classes related to its members': {
    body: `package domain {
  class Order
  class Product
}
class Customer
class Warehouse
class Supplier
Customer --> Order : places
Order --> Product : lists
Warehouse --> Product : stocks
Supplier --> Warehouse : supplies
Supplier ..> Product : makes`,
    members: { domain: ['Order', 'Product'] },
  },
  'nested packages': {
    body: `package shop {
  class Cart
  package catalog {
    class Product
    class Category
  }
  package checkout {
    class Payment
  }
}
class User
User --> Cart : owns
Cart --> Product : holds
Product --> Category : in
Cart --> Payment : pays
User ..> Payment : authorizes`,
    members: { shop: ['Cart', 'Product', 'Category', 'Payment'], catalog: ['Product', 'Category'], checkout: ['Payment'] },
    parents: { catalog: 'shop', checkout: 'shop' },
  },
  'a package with one member': {
    body: `package auth {
  class Session
}
class User
class Token
User --> Session : opens
Session --> Token : issues
User ..> Token : holds`,
    members: { auth: ['Session'] },
  },
  'relationships crossing between packages': {
    body: `package model {
  abstract class Shape
  class Circle
  class Square
}
package view {
  class Canvas
  class Renderer
}
Circle --|> Shape
Square --|> Shape
Canvas --> Shape : draws
Renderer --> Canvas : paints
Shape ..> Renderer : uses
Renderer ..> Circle : styles`,
    members: { model: ['Shape', 'Circle', 'Square'], view: ['Canvas', 'Renderer'] },
  },
  'a note and a callout inside a package': {
    body: `package orders {
  class Order {
    +total(): double
  }
  class LineItem
}
class Customer
Customer --> Order : places
Order *-- LineItem : contains
note right of Order : the sum of its line items
callout bottom of text "LineItem" : A part: it lives and dies with its order`,
    members: { orders: ['Order', 'LineItem'] },
  },
};

const COMPONENT = {
  'two sibling packages': {
    body: `package Frontend {
  component Web
  component Mobile
}
package Backend {
  component API
  component Worker
}
component Database
Web --> API : calls
Mobile --> API : calls
API --> Worker : enqueues
Worker --> Database : writes
Web --> Database : reads`,
    members: { Frontend: ['Web', 'Mobile'], Backend: ['API', 'Worker'] },
  },
  'a package and loose components related to its members': {
    body: `package Ordering {
  component Cart
  component Checkout
}
component Catalog
component Payments
component Shipping
Catalog --> Cart : fills
Cart --> Checkout : submits
Checkout --> Payments : charges
Checkout --> Shipping : ships
Shipping --> Catalog : updates`,
    members: { Ordering: ['Cart', 'Checkout'] },
  },
  'nested packages': {
    body: `package Platform {
  component Gateway
  package Services {
    component Accounts
    component Billing
  }
  package Data {
    component Store
  }
}
component Client
Client --> Gateway : requests
Gateway --> Accounts : routes
Gateway --> Billing : routes
Accounts --> Store : reads
Billing --> Store : writes
Client --> Billing : pays`,
    members: { Platform: ['Gateway', 'Accounts', 'Billing', 'Store'], Services: ['Accounts', 'Billing'], Data: ['Store'] },
    parents: { Services: 'Platform', Data: 'Platform' },
  },
  'a package with one member': {
    body: `package Security {
  component Auth
}
component Web
component Users
Web --> Auth : signs in
Auth --> Users : looks up
Web --> Users : shows`,
    members: { Security: ['Auth'] },
  },
  'relationships crossing between packages': {
    body: `package Sales {
  component Orders
  component Quotes
}
package Stock {
  component Inventory
  component Purchasing
}
Orders --> Inventory : reserves
Inventory --> Quotes : prices
Purchasing --> Orders : backorders
Quotes --> Purchasing : requests
Orders --> Quotes : converts`,
    members: { Sales: ['Orders', 'Quotes'], Stock: ['Inventory', 'Purchasing'] },
  },
  'a note and a callout inside a package': {
    body: `package Backend {
  component API
  component Worker
}
component Web
Web --> API : calls
API --> Worker : enqueues
note right of Worker : retries three times
callout bottom of text "Worker" : Runs jobs off the request path`,
    members: { Backend: ['API', 'Worker'] },
  },
};

module.exports = { CLASS, COMPONENT };
