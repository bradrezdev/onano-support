import styles from './page.module.css'

export default function Page() {
  return (
    <main className={styles.main}>
      <h1>WhatsApp CRM — API</h1>
      <p>Backend Next.js. Endpoints bajo <code>/api/*</code>.</p>
      <p>
        UI en <a href="http://localhost:5173">apps/web (Vite, en proceso de
        reescritura a React)</a>.
      </p>
      <ul>
        <li><a href="/api/health">/api/health</a> — smoke check</li>
        <li><a href="/api/me">/api/me</a> — usuario autenticado (próximamente)</li>
      </ul>
    </main>
  )
}