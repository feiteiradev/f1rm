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
        {name} reads this at its next step and may act on it. A working session isn't interrupted mid-tool; an idle one starts a new turn. If it holds messages for approval, approve this one in its terminal.
      </p>
    </section>
  );
}
