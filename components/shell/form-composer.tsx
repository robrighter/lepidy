import { ClipboardPlus, Send } from "lucide-react";

import { submitFormDataAction } from "@/app/(app)/c/[channel]/queue-actions";
import type { FormDefinition } from "@/src/domain/work-queues";

/** Native details + Server Action: usable during hydration and with scripting off. */
export function FormComposer({ channelId, channelLabel, definition, canPost, csrfToken, requestKey }: {
  channelId: string;
  channelLabel: string;
  definition: FormDefinition | null;
  canPost: boolean;
  csrfToken: string;
  requestKey: string;
}) {
  if (definition === null) return <p className="composer-notice">The room owner hasn&apos;t finished setting up this form.</p>;
  if (!canPost) return <p className="composer-notice">Join #{channelLabel} to submit an entry.</p>;
  return (
    <section className="form-composer" aria-label="Submit an entry">
      {definition.instructions ? <p className="form-instructions">{definition.instructions}</p> : null}
      <details className="form-entry-details">
        <summary className="primary form-open"><ClipboardPlus size={16} aria-hidden="true" /> Submit an entry</summary>
        <form action={submitFormDataAction}>
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="channelId" value={channelId} />
          <input type="hidden" name="returnPath" value={`/c/${encodeURIComponent(channelLabel)}`} />
          <input type="hidden" name="idempotencyKey" value={requestKey} />
          <div className="form-fields">
            {definition.fields.map((field) => (
              <label key={field.id} className="form-field">
                <span>{field.label}{field.required ? <b aria-label="required"> *</b> : null}</span>
                {field.type === "long_text" ? (
                  <textarea name={`field:${field.id}`} required={field.required} rows={4} />
                ) : field.type === "single_select" ? (
                  <select name={`field:${field.id}`} required={field.required} defaultValue="">
                    <option value="">Choose…</option>{field.options.map((option) => <option key={option}>{option}</option>)}
                  </select>
                ) : field.type === "multi_select" ? (
                  <span className="form-options">{field.options.map((option) => <label key={option}><input name={`field:${field.id}`} type="checkbox" value={option} />{option}</label>)}</span>
                ) : (
                  <input name={`field:${field.id}`} required={field.required} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} placeholder={field.type === "person" ? "@handle" : undefined} />
                )}
              </label>
            ))}
          </div>
          <div className="form-submit-actions"><button className="primary" type="submit"><Send size={15} />Submit entry</button></div>
        </form>
      </details>
    </section>
  );
}
