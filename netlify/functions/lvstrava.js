const https = require("https");

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  const action = event.queryStringParameters?.action;
  const code = event.queryStringParameters?.code;
  const token = event.queryStringParameters?.token;

  const CLIENT_ID = process.env.STRAVA_CLIENT_ID || "260864";
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
  const CALLBACK_URL = "https://coach-nutrition.netlify.app/.netlify/functions/lvstrava?action=callback";

  // Action 1: Lancer l'authentification Strava
  if (action === "connect") {
    const url = `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=read,activity:read_all&approval_prompt=auto`;
    return {
      statusCode: 302,
      headers: { Location: url, ...h },
      body: "",
    };
  }

  // Action 2: Callback OAuth — échange du code contre un token
  if (action === "callback" && code) {
    const body = JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      grant_type: "authorization_code",
    });

    return new Promise((resolve) => {
      const options = {
        hostname: "www.strava.com",
        path: "/api/v3/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const resp = JSON.parse(data);
            if (resp.access_token) {
              // Rediriger vers l'appli avec le token dans l'URL (le client va le stocker)
              resolve({
                statusCode: 302,
                headers: {
                  Location: `https://skeunou.github.io/coach-renfo/trail-v2.html?strava_token=${resp.access_token}`,
                  ...h,
                },
                body: "",
              });
            } else {
              resolve({
                statusCode: 400,
                headers: h,
                body: JSON.stringify({ error: resp.message || "OAuth failed" }),
              });
            }
          } catch (e) {
            resolve({
              statusCode: 500,
              headers: h,
              body: JSON.stringify({ error: e.message }),
            });
          }
        });
      });

      req.on("error", (e) => {
        resolve({
          statusCode: 500,
          headers: h,
          body: JSON.stringify({ error: e.message }),
        });
      });
      req.write(body);
      req.end();
    });
  }

  // Action 3: Récupérer les données Strava avec le token
  if (action === "data" && token) {
    return new Promise((resolve) => {
      const options = {
        hostname: "www.strava.com",
        path: "/api/v3/athlete/activities?per_page=10&sort=start_date_desc",
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const activities = JSON.parse(data);
            if (!Array.isArray(activities)) {
              return resolve({
                statusCode: 401,
                headers: h,
                body: JSON.stringify({ error: "Token invalid or expired" }),
              });
            }
            let totalKm = 0, totalD = 0;
            const last = activities[0];
            activities.forEach((a) => {
              if (a.distance) totalKm += a.distance / 1000;
              if (a.total_elevation_gain) totalD += a.total_elevation_gain;
            });
            resolve({
              statusCode: 200,
              headers: h,
              body: JSON.stringify({
                kmRecent: totalKm.toFixed(1),
                dRecent: Math.round(totalD),
                lastActivity: last?.name || "—",
                lastDate: last?.start_date?.split("T")[0] || "",
                activities: activities.slice(0, 3).map((a) => ({
                  name: a.name,
                  km: (a.distance / 1000).toFixed(1),
                  date: a.start_date?.split("T")[0],
                })),
              }),
            });
          } catch (e) {
            resolve({
              statusCode: 500,
              headers: h,
              body: JSON.stringify({ error: e.message }),
            });
          }
        });
      });

      req.on("error", (e) => {
        resolve({
          statusCode: 500,
          headers: h,
          body: JSON.stringify({ error: e.message }),
        });
      });
      req.end();
    });
  }

  return {
    statusCode: 400,
    headers: h,
    body: JSON.stringify({ error: "Invalid action" }),
  };
};
