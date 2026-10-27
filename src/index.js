// Start the server: npm start
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();
const server = createServer({ config });
server.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log(`AI Shopping Check running at http://${config.host}:${port}`);
});
