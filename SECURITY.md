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

## Supported versions

Nothing is published yet. Before `1.0`, fixes go into the latest release only.
