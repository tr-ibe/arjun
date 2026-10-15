import { useState, type FormEvent } from "react";
import { api, type ApiKey } from "../api";
import { clock, timeAgo } from "../format";
import { useReloadable } from "../hooks";

export function Keys() {
  const keys = useReloadable(() => api<ApiKey[]>("/api/keys"), null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<ApiKey & { key: string }>("/api/keys", { method: "POST", body: { name } });
      setCreated({ name: res.name, key: res.key });
      setCopied(false);
      setName("");
      void keys.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(id: number) {
    setError(null);
    try {
      await api(`/api/keys/${id}/revoke`, { method: "POST" });
      setConfirmId(null);
      void keys.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>API keys</h1>
      </div>
      <p className="muted lead">
        Give each service that calls this API its own key, so every task shows where it came from and one key can be
        revoked without affecting the others. Send it as <code>Authorization: Bearer &lt;key&gt;</code>.
      </p>

      <form className="card inline-form" onSubmit={create}>
        <label htmlFor="key-name">Name</label>
        <input
          id="key-name"
          placeholder="e.g. mytribe, trigger, agent0"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
        <button className="primary" disabled={!name.trim()}>
          Create key
        </button>
      </form>

      {created && (
        <div className="card new-key">
          <strong>Key for {created.name}</strong>
          <p>Copy it now. It won't be shown again.</p>
          <div className="key-row">
            <code className="key">{created.key}</code>
            <button className="secondary" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.data?.map((k) => (
              <tr key={k.id} className={k.revoked_at ? "revoked" : ""}>
                <td>{k.name}</td>
                <td className="mono">{k.key_prefix}…</td>
                <td>{clock(k.created_at)}</td>
                <td>{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</td>
                <td className="right">
                  {k.revoked_at ? (
                    <span className="muted">Revoked {clock(k.revoked_at)}</span>
                  ) : confirmId === k.id ? (
                    <span className="confirm">
                      Revoke {k.name}?{" "}
                      <button className="danger" onClick={() => revoke(k.id)}>
                        Revoke
                      </button>{" "}
                      <button className="secondary" onClick={() => setConfirmId(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button className="secondary" onClick={() => setConfirmId(k.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {keys.data?.length === 0 && <div className="empty">No keys yet. Create one for each service that will call the API.</div>}
      </div>
    </>
  );
}
