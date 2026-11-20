# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it privately, in either of two ways:

- through GitHub's private vulnerability reporting: **Security** → **Report a vulnerability** on
  this repository;
- by email to security@arkor.ai.

We will acknowledge a report within 48 hours.

Two kinds of report matter most here, because the package's whole purpose is to hold them:

- a way for a page to see a value its component's own code would refuse it, or to change one it
  would refuse to change;
- a way for one session's state, or one viewer's render, to reach another.

## What a write trusts the page with

A write names an update the compile registered for that state. The authority runs the update
itself, of the field's current value, and checks what it makes against the field (its type, its
length or range, what must stay unique) and that the session may still write it. Two things in a
write are the page's to say, and the authority takes them as it takes any request body:

- the value of a `set`;
- the values an update's call captured. `setCount((count) => Math.min(count + 1, limit))` captures
  `limit`: a prop, a state or a constant of the component, a custom hook's parameter. They cross as
  JSON, 4,096 characters at most. The authority neither computes them again nor signs them.

So a captured value keeps no bound for the server. A page that sends other captured values than its
component held has the registered update make another value the field accepts, of a field its
session may already write: that is this model, and not a vulnerability. A bound the server must keep
belongs in the field (its type, length or range) or in a server operation, which runs on the server
of the server's own values.

What the first kind of report above means, then: a way to write a field the session may not write,
a value the field refuses, or through an update the component did not register for that state.

## Supported versions

Nothing is published yet. Before `1.0`, fixes go into the latest release only.
