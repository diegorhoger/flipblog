import { app } from './app.js';
import { config } from './config.js';
import { seedUserIfMissing } from './services/users.js';
import { seedSamplePosts } from './seed.js';

seedUserIfMissing()
  .then(() => seedSamplePosts())
  .then(() => {
    app.listen(config.port, config.host, () => {
      console.log(`FlipBlog server listening on http://${config.host}:${config.port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start FlipBlog:', err);
    process.exit(1);
  });
