import { readFileSync } from 'node:fs';

const serverSchema = readFileSync('server/src/schemas/sale.ts', 'utf8');
const clientSchema = readFileSync('client/src/schemas/sale.ts', 'utf8');

if (serverSchema !== clientSchema) {
  console.error('Server and client sale schemas differ.');
  process.exitCode = 1;
} else {
  console.log('Server and client sale schemas are in sync.');
}
