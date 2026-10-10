const env = process.env;
const need = (k) => { if (!env[k]) throw new Error(`Missing required env var ${k}`); return env[k]; };

export const config = {
  port: Number(env.PORT) || 4000,
  databaseUrl: need('DATABASE_URL'),
  ipHashSecret: need('IP_HASH_SECRET'),
  appOrigin: need('APP_ORIGIN').replace(/\/$/, ''),
  secureCookies: env.NODE_ENV === 'production',
  trustProxy: Number(env.TRUST_PROXY) || 0,
  autoApproveLow: env.AUTO_APPROVE_LOW === 'true',
  minSalaryReports: Number(env.MIN_SALARY_REPORTS) || 5,
};
