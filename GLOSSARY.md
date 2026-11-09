# f1rm

A local office where every Claude Code session is an employee, and a company that turns the user's asks into merged work. The user confirms what done looks like before work starts, can see why each piece is built, and makes the decisions only they can.

## Language

### Work

**Ask**:
The user's own words for what they want, kept verbatim on its spec.
_Avoid_: Request, prompt, brief

**Example**:
One concrete, checkable outcome of an ask that the user confirmed before work started; a spec is done when its examples pass.
_Avoid_: User story, acceptance criterion, scenario

**Spec**:
One feature the user asked for, described well enough to be cut into tickets.
_Avoid_: Topic, milestone, slice, epic, PRD

**Ticket**:
One slice of a spec that can be built and checked on its own, naming the tickets that block it.
_Avoid_: Task, card, row

**Step**:
One stage of a spec's life (spec, tickets, implement, close) carried out by one short session that ends with it.
_Avoid_: Shift, run, phase

**Role**:
The kind of work a ticket needs, which sets the skills used on it.
_Avoid_: Specialist, owner

### The user's seat

**Prototype**:
A throwaway, clickable version of what a spec will reach, which the user accepts before any tickets are cut.
_Avoid_: Mockup, demo, preview

**Preview**:
What a spec's tickets would change, as main's behaviour now against after, each change naming the example that asks for it.
_Avoid_: Diff, plan review, impact analysis

**Fresh-eyes review**:
The review that writes a spec's preview, by an intern that knows nothing but the issues and main.
_Avoid_: Audit, second opinion

**Decision ticket**:
An open question only the user can answer, with its options and a recommended answer.
_Avoid_: Card, approval, NEEDS YOU

**Cost unit**:
The measure of what work spends, as tokens weighted by their price.
_Avoid_: Tokens (for cost), credits

**Budget**:
The most cost units a ticket may spend before it stops for a decision.
_Avoid_: Cap, limit

### The office

**Employee**:
A Claude Code session, shown at a desk in its project's office.
_Avoid_: Agent, worker, hire (as a noun)

**PM**:
The employee the user talks to when asking for work; it turns the ask into a spec.
_Avoid_: Scribe, front desk, lead

**Intern**:
A subagent of an employee, shown walking in the office while it works.
_Avoid_: Implementer (in the office), helper
