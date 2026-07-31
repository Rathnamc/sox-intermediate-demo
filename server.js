// AZ-400 Exam Trainer — static server
// Serves the trainer app from /public on Azure App Service (Linux).

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080; // Azure assigns PORT

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) =>
  res.json({ status: 'ok', app: 'az400-trainer', uptime: process.uptime() }));

app.listen(PORT, () => console.log(`AZ-400 trainer on ${PORT}`));
