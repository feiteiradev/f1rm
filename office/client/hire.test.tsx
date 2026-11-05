// The Hire dialog's count line (how many hires work, with no cap) and its Hire anyway confirm (past the usage pacing).
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HireAnyway, HireCount } from "./hire.tsx";

test("Hire anyway asks to go past the usage pacing, never past a cap", () => {
  const markup = renderToStaticMarkup(<HireAnyway role="Designer" working={9} onYes={() => {}} onCancel={() => {}} />);
  expect(markup).toContain('aria-label="Confirm hiring past the usage pacing"');
  expect(markup).toContain("Hire a designer past the usage pacing? That makes 10 hires working, each using your Claude usage. Your yes is the approval to go past it.");
  expect(markup).toContain(">Yes, hire anyway<");
  expect(markup).toContain(">Cancel<");
  expect(markup).not.toContain("cap");
});

test("the Hire dialog says how many hires work and names no cap", () => {
  const markup = renderToStaticMarkup(<HireCount working={3} />);
  expect(markup).toContain(">3 hires working.<");
  expect(markup).not.toContain("of 8");
  expect(markup).not.toContain("cap");
  expect(renderToStaticMarkup(<HireCount working={9} />)).toContain(">9 hires working.<");
  expect(renderToStaticMarkup(<HireCount working={1} />)).toContain(">1 hire working.<");
  expect(renderToStaticMarkup(<HireCount working={0} />)).toContain(">0 hires working.<");
  expect(renderToStaticMarkup(<HireCount working={null} />)).toContain("The working hires couldn&#x27;t be counted.");
});
