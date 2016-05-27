// @flow

import pg from 'pg';
const DATABASE_URL = 'postgres://localhost/postgres';

// executes a SQL query and returns the result directly from pg
export function exec(
  query: string,
  escapes: ?string[]
): Promise<Object> {
  return new Promise((resolve, reject) => {
    pg.connect(DATABASE_URL, (err, client, done) => {
      if (err) {
        reject(err);
      }
      client.query(query, escapes, (err, result) => {
        if (err) {
          reject(err);
        }
        resolve(result);
        done();
      });
    });
  });
}

// exectutes a query expecting a single row - it returns the row as an
// object, and raises if it receives more than one.
export async function find(
  query: string,
  escapes: ?string[]
): Promise<Object> {
  const result = await exec(query, escapes);
  console.log(result);
  return {};
}

// executes a query expecting to find many rows - it returns an array of objects
export async function query(
  query: string,
  escapes?: string[]
): Promise<Object[]> {
  const result = await exec(query, escapes);
  console.log(result);
  return [{}];
}

export async function reset(): Promise<true> {
  await exec(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO postgres;
    GRANT ALL ON SCHEMA public TO public;
    COMMENT ON SCHEMA public IS 'standard public schema';
  `);
  return true;
}
