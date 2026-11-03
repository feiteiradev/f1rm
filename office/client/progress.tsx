// The project room's progress: one block per topic, with its desk lines. Every desk and board word is only ever a React text child.
import type { Topic } from "../server/progress.ts";
import { ago, proofHref } from "./progress.ts";
import "./progress.css";

export function Progress({ topics, repo, now = Date.now() }: { topics: Topic[]; repo: string; now?: number }) {
  if (!topics.length) return null;
  return (
    <section className="progress" aria-label="Topic progress">
      {topics.map((t) => (
        <article key={t.team}>
          <h3>{t.team}</h3>
          <p className="count">{t.done} / {t.total} done</p>
          <div className="meter" role="progressbar" aria-label={`${t.team} progress`} aria-valuemin={0} aria-valuemax={t.total} aria-valuenow={t.done}>
            <span style={{ width: `${t.total ? (100 * t.done) / t.total : 0}%` }} />
          </div>
          {t.last && <p className="last">last: {t.last.task}{t.last.at && ago(t.last.at, now) ? ` (${ago(t.last.at, now)})` : ""}</p>}
          {t.stuck.length ? (
            <ul className="stuck" aria-label="Stuck">
              {t.stuck.map((s, i) => <li key={i}>stuck: {s}</li>)}
            </ul>
          ) : (
            <p className="none">stuck: none</p>
          )}
          {t.desk.length > 0 && (
            <ul className="desk" aria-label={`${t.team} desk`}>
              {t.desk.map((d, i) => {
                const href = proofHref(d.proof, repo, t.team);
                return (
                  <li key={i}>
                    <span className="mark" aria-hidden />
                    <span className="task">{d.task}</span>
                    {href && <a href={href} target="_blank" rel="noreferrer">{`proof: ${d.proof.split("/").pop()}`}</a>}
                    <span className="what">{d.note}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
