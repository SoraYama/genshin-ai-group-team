import { readConfig } from './config.js';
import { buildServer } from './server.js';

async function main() {
  const config = readConfig();
  const app = buildServer({ config });

  try {
    await app.listen({
      port: config.port,
      host: '0.0.0.0'
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
