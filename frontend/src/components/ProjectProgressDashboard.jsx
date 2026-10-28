const tasks = [
  {
    title: "Wallet connection and local network",
    status: "Verify locally",
    detail: "Connect MetaMask to Hardhat Local (chain ID 31337) and confirm the contract is connected.",
    tone: "warning",
  },
  {
    title: "Client-side file encryption",
    status: "Verify locally",
    detail: "Encrypt a sample file and confirm the key stays in browser memory unless you export a backup.",
    tone: "warning",
  },
  {
    title: "Encryption-key backup",
    status: "Added — test required",
    detail: "Export a JSON key backup, refresh the page, import it, and test decryption.",
    tone: "warning",
  },
  {
    title: "IPFS upload and retrieval",
    status: "Verify locally",
    detail: "Check that Kubo and the backend are running, then upload and retrieve an encrypted file.",
    tone: "warning",
  },
  {
    title: "Blockchain file registry",
    status: "Verify locally",
    detail: "Confirm the CID and file metadata appear in the contract and in My Files.",
    tone: "warning",
  },
  {
    title: "My Files dashboard",
    status: "Added — test required",
    detail: "Check file list, metadata, refresh, empty state, and wallet/network changes.",
    tone: "warning",
  },
  {
    title: "Share and revoke access",
    status: "Added — test required",
    detail: "Test with a second local wallet. Sharing permissions does not deliver the encryption key.",
    tone: "warning",
  },
  {
    title: "Backend wallet-signature authorization",
    status: "Pending",
    detail: "Add nonce/signature verification and authorization checks to protected backend routes.",
    tone: "pending",
  },
  {
    title: "Automated tests and production build",
    status: "Pending verification",
    detail: "Run frontend tests/build, Hardhat compile/tests, and backend tests after syncing this branch.",
    tone: "pending",
  },
  {
    title: "Documentation and final review",
    status: "Pending",
    detail: "Update README to match the actual implementation, document setup, limitations, and test results.",
    tone: "pending",
  },
];

export default function ProjectProgressDashboard() {
  const completed = tasks.filter((task) => task.status.startsWith("Verified")).length;
  const needsWork = tasks.length - completed;

  return (
    <section className="status-panel project-progress" aria-labelledby="project-progress-heading">
      <div className="project-progress-header">
        <div>
          <p className="project-eyebrow">PROJECT OVERVIEW</p>
          <h2 id="project-progress-heading">Development Checklist</h2>
          <p className="placeholder-note">Use this panel to track the final checks before presenting or submitting the project.</p>
        </div>
        <div className="progress-count" aria-label={`${completed} of ${tasks.length} tasks verified`}>
          <strong>{completed}/{tasks.length}</strong>
          <span>verified</span>
        </div>
      </div>

      <div className="project-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax={tasks.length} aria-valuenow={completed}>
        <span style={{ width: `${(completed / tasks.length) * 100}%` }} />
      </div>

      <div className="project-task-list">
        {tasks.map((task, index) => (
          <article className="project-task" key={task.title}>
            <span className={`project-task-number project-task-${task.tone}`}>{String(index + 1).padStart(2, "0")}</span>
            <div className="project-task-content">
              <div className="project-task-heading">
                <h3>{task.title}</h3>
                <span className={`project-task-status project-task-status-${task.tone}`}>{task.status}</span>
              </div>
              <p>{task.detail}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="banner banner-warning">
        These are planning statuses, not automatic test results. Tasks only count as complete after you run and verify them on your computer.
      </div>
    </section>
  );
}
