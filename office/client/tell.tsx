// Tell: steers an employee. Built to look nothing like Ask, which only reads: a boxed coral section, a multi-line field and a button that names who is being steered.
import { useState } from "react";
import "./tell.css";

export function TellBox({ name, onTell }: { name: string; onTell: (message: string) => void }) {
  const [message, setMessage] = useState("");
  const send = () => {
    if (!message.trim()) return;
    onTell(message.trim());
    setMessage("");
  };
  return (
    <section className="tell" aria-label="Tell">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label htmlFor="tell-message">Tell {name} to change course</label>
        <textarea
          id="tell-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && (e.preventDefault(), send())}
          placeholder="Use the staging database from here on."
          maxLength={4000}
          rows={3}
        />
        <button type="submit" disabled={!message.trim()}>Tell {name}</button>
      </form>
      <p className="warn">
        {name} reads this at its next step and may act on it. A running tool isn't interrupted; an idle session starts a new turn. If it holds the message for approval, approve it in its terminal.
      </p>
    </section>
  );
}

/** Give them an intern: the subtask is typed here, and the office asks the employee to hand it to a sub-agent. */
export function InternBox({ name, onIntern }: { name: string; onIntern: (subtask: string) => void }) {
  const [subtask, setSubtask] = useState("");
  return (
    <section className="intern" aria-label="Give them an intern">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!subtask.trim()) return;
          onIntern(subtask.trim());
          setSubtask("");
        }}
      >
        <label htmlFor="intern-subtask">Give {name} an intern</label>
        <div className="row">
          <input id="intern-subtask" value={subtask} onChange={(e) => setSubtask(e.target.value)} placeholder="Check the staging logs." maxLength={4000} autoComplete="off" />
          <button type="submit" disabled={!subtask.trim()}>Send</button>
        </div>
      </form>
      <p className="warn">A Tell asking {name} to hand this subtask to a sub-agent. It is read at its next step.</p>
    </section>
  );
}
