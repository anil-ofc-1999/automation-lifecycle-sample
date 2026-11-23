import { createApp } from './app.js';
import { assertRequiredConfig, config } from './config.js';
import { prisma } from './db.js';
import { flushNotifications } from './notifications/appointmentEmails.js';

assertRequiredConfig();

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port} (${config.env})`);
});

// Graceful shutdown (Ctrl+C locally, SIGTERM from container platforms)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down...`);
    server.close(async () => {
      await flushNotifications(); // let emails that are on their way finish
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
