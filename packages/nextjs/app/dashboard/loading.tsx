import styles from "./dashboard.module.css";

export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true">
      <header className={styles.header}>
        <div>
          <h1>Hedera environment</h1>
          <p className={styles.subtitle}>Checking the network, Mirror Node, relay, HCS topic and contract…</p>
        </div>
      </header>
      <div className={styles.grid}>
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
      </div>
    </main>
  );
}
