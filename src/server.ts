import express from "express";
import { Client } from "discord.js";
import { config } from "./config";

const app = express();
const PORT = process.env.PORT || 3000;

export function startDashboard(client: Client) {
    app.get("/", (req, res) => {
        const memoryUsage = process.memoryUsage();
        const ramUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024);
        const ramTotal = Math.round(memoryUsage.heapTotal / 1024 / 1024);
        const ping = client.ws.ping;
        const guildCount = client.guilds.cache.size;
        const uptimeSeconds = Math.floor(process.uptime());
        const days = Math.floor(uptimeSeconds / (3600 * 24));
        const hours = Math.floor(uptimeSeconds % (3600 * 24) / 3600);
        const mins = Math.floor(uptimeSeconds % 3600 / 60);

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>VoidTools | Dashboard</title>
            <style>
                body {
                    background-color: #0f1115;
                    color: #ffffff;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                }
                .container {
                    background-color: #1a1d24;
                    padding: 40px;
                    border-radius: 12px;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                    text-align: center;
                    border: 1px solid #2a2e38;
                    width: 400px;
                }
                h1 {
                    color: #5865F2; /* Discord Blurple */
                    margin-bottom: 20px;
                }
                .stat-box {
                    background-color: #232731;
                    padding: 15px;
                    margin: 10px 0;
                    border-radius: 8px;
                    display: flex;
                    justify-content: space-between;
                    font-size: 1.1em;
                }
                .label { color: #a1aab8; }
                .value { font-weight: bold; color: #43b581; } /* Discord Green */
                .footer {
                    margin-top: 30px;
                    font-size: 0.9em;
                    color: #72767d;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔮 VoidTools Bot</h1>
                <div class="stat-box">
                    <span class="label">Status:</span>
                    <span class="value" style="color: #43b581;">Online & Secure</span>
                </div>
                <div class="stat-box">
                    <span class="label">Ping:</span>
                    <span class="value" style="color: ${ping > 200 ? '#faa61a' : '#43b581'};">${ping}ms</span>
                </div>
                <div class="stat-box">
                    <span class="label">Servers:</span>
                    <span class="value" style="color: #ffffff;">${guildCount}</span>
                </div>
                <div class="stat-box">
                    <span class="label">RAM Usage:</span>
                    <span class="value" style="color: #ffffff;">${ramUsed} MB / ${ramTotal} MB</span>
                </div>
                <div class="stat-box">
                    <span class="label">Uptime:</span>
                    <span class="value" style="color: #ffffff;">${days}d ${hours}h ${mins}m</span>
                </div>
                <div class="footer">
                    ${config.credits}<br>
                    Keep this page open on UptimeRobot to prevent Replit sleep.
                </div>
            </div>
        </body>
        </html>
        `;

        res.send(html);
    });

    app.listen(PORT, () => {
        console.log(`Web Dashboard listening on port ${PORT}`);
    });
}
