import { app } from './app.js';
import { config } from './config.js';
import { seedUserIfMissing } from './services/users.js';
import { seedSamplePosts } from './seed.js';
import { closeDb } from './db.js';
import { createGracefulShutdown } from './shutdown.js';

seedUserIfMissing()
  .then(() => seedSamplePosts())
  .then(() => {
    const server = app.listen(config.port, config.host, () => {
      console.log(`FlipBlog server listening on http://${config.host}:${config.port}`);
    });
    // SIGTERM (systemd stop/restart) and SIGINT (Ctrl-C) trigger a bounded
    // graceful shutdown: stop accepting connections, drain in-flight requests,
    // close the database, then exit. See src/shutdown.js.
    createGracefulShutdown({ server, closeDb, graceMs: config.shutdownGraceMs });
  })
  .catch((err) => {
    console.error('Failed to start FlipBlog:', err);
    process.exit(1);
  });
