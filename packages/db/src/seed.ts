import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel";
const sql = postgres(url);
await sql`insert into organizations (id, name) values ('org_demo', 'MailSentinel Demo') on conflict (id) do nothing`;
await sql`insert into "user" (id, email, name) values ('user_demo', 'demo@mailsentinel.local', 'Demo Investigator') on conflict do nothing`;
await sql.end();
console.log("Seeded MailSentinel demo records");
