import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';

import { regionMappings } from './regions.js';

dotenv.config();

const app = express();

const allowedOrigins = ['http://localhost:3000', 'http://localhost:5173'];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) === -1) {
        const msg =
          'The CORS policy for this site does not allow access from the specified Origin.';
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    credentials: true,
  }),
);

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
});
app.use(limiter);

const cache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  maxKeys: 1000,
});

const CACHE_DURATIONS = {
  summoner: 3600,
  ranked: 300,
  championStats: 1800,
  matchHistory: 300,
};

const getRiotData = async (cacheKey, ttl, apiCall) => {
  const cachedData = cache.get(cacheKey);

  if (cachedData) {
    console.log(`Cache hit for ${cacheKey}`);
    return cachedData;
  }

  console.log(`Cache miss for ${cacheKey}`);
  const data = await apiCall();

  cache.set(cacheKey, data, ttl);
  return data;
};

app.get('/summoner/:name/:tag/:region', async (req, res) => {
  try {
    const { name, tag, region } = req.params;
    const regionConfig = regionMappings[region];

    const summonerCacheKey = `summoner-${region}-${name}-${tag}`;

    const summonerData = await getRiotData(
      summonerCacheKey,
      CACHE_DURATIONS.summoner,
      async () => {
        const riotIdResponse = await axios.get(
          `https://${regionConfig.regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${name}/${tag}`,
          {
            headers: { 'X-Riot-Token': process.env.RIOT_API_KEY },
          },
        );

        const summonerResponse = await axios.get(
          `https://${regionConfig.platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${riotIdResponse.data.puuid}`,
          {
            headers: { 'X-Riot-Token': process.env.RIOT_API_KEY },
          },
        );

        return summonerResponse.data;
      },
    );

    res.json(summonerData);
  } catch (error) {
    console.error('Error details:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

app.get('/ranked/:summonerId/:region', async (req, res) => {
  try {
    const { summonerId, region } = req.params;
    const regionConfig = regionMappings[region];

    const rankedCacheKey = `ranked-${region}-${summonerId}`;

    const rankedData = await getRiotData(
      rankedCacheKey,
      CACHE_DURATIONS.ranked,
      async () => {
        const response = await axios.get(
          `https://${regionConfig.platform}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summonerId}`,
          {
            headers: { 'X-Riot-Token': process.env.RIOT_API_KEY },
          },
        );
        return response.data;
      },
    );

    res.json(rankedData);
  } catch (error) {
    console.error('Error details:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

app.get('/ranked-champions/:puuid/:region', async (req, res) => {
  try {
    const { puuid, region } = req.params;
    const regionConfig = regionMappings[region];
    const currentSeason = 'S2025';

    const statsCacheKey = `ranked-champions-${region}-${puuid}-${currentSeason}`;

    const statsData = await getRiotData(
      statsCacheKey,
      CACHE_DURATIONS.championStats,
      async () => {
        const matchIdsResponse = await axios.get(
          `https://${regionConfig.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`,
          {
            params: {
              queue: 420,
              startTime: 1704758400,
              count: 100,
            },
            headers: { 'X-Riot-Token': process.env.RIOT_API_KEY },
          },
        );

        // Get match details
        const matchDetailsPromises = matchIdsResponse.data.map(matchId =>
          axios.get(
            `https://${regionConfig.regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
            {
              headers: { 'X-Riot-Token': process.env.RIOT_API_KEY },
            },
          ),
        );

        const matchDetails = await Promise.all(matchDetailsPromises);

        const championStats = {};

        matchDetails.forEach(match => {
          const participant = match.data.info.participants.find(
            p => p.puuid === puuid,
          );

          if (!participant) return;

          const championId = participant.championId;
          const championName = participant.championName;

          if (!championStats[championId]) {
            championStats[championId] = {
              championId,
              championName,
              games: 0,
              wins: 0,
              kills: 0,
              deaths: 0,
              assists: 0,
              cs: 0,
            };
          }

          const stats = championStats[championId];
          stats.games += 1;
          stats.wins += participant.win ? 1 : 0;
          stats.kills += participant.kills;
          stats.deaths += participant.deaths;
          stats.assists += participant.assists;
          stats.cs +=
            participant.totalMinionsKilled + participant.neutralMinionsKilled;
        });

        const finalStats = Object.values(championStats)
          .map(stats => ({
            championId: stats.championId,
            championName: stats.championName,
            gamesPlayed: stats.games,
            winRate: Math.round((stats.wins / stats.games) * 100),
            kda: {
              kills: (stats.kills / stats.games).toFixed(1),
              deaths: (stats.deaths / stats.games).toFixed(1),
              assists: (stats.assists / stats.games).toFixed(1),
              ratio: (
                (stats.kills + stats.assists) /
                Math.max(stats.deaths, 1)
              ).toFixed(2),
            },
            cs: (stats.cs / stats.games).toFixed(1),
          }))
          .sort((a, b) => b.gamesPlayed - a.gamesPlayed);

        return {
          season: currentSeason,
          queue: 'Ranked Solo',
          champions: finalStats,
        };
      },
    );

    res.json(statsData);
  } catch (error) {
    console.error('Error details:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

app.get('/match-history/:puuid/:region/:queue?', async (req, res) => {
  try {
    const { puuid, region } = req.params;
    const queue = req.params.queue || 'ranked';
    const regionConfig = regionMappings[region];

    const matchHistoryCacheKey = `match-history-${region}-${puuid}-${queue}`;

    const matchHistory = await getRiotData(
      matchHistoryCacheKey,
      CACHE_DURATIONS.matchHistory,
      async () => {
        const matchIdsResponse = await axios.get(
          `https://${regionConfig.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`,
          {
            params: {
              queue: queue === 'ranked' ? 420 : undefined,
              count: 20,
              type: 'ranked',
            },
            headers: { 'X-Riot-Token': process.env.RIOT_API_KEY },
          },
        );

        const matchDetailsPromises = matchIdsResponse.data.map(matchId =>
          axios.get(
            `https://${regionConfig.regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
            {
              headers: { 'X-Riot-Token': process.env.RIOT_API_KEY },
            },
          ),
        );

        const matchDetails = await Promise.all(matchDetailsPromises);

        return matchDetails.map(match => {
          const gameData = match.data;
          const participant = gameData.info.participants.find(
            p => p.puuid === puuid,
          );

          const durationInSeconds = gameData.info.gameDuration;
          const minutes = Math.floor(durationInSeconds / 60);
          const seconds = durationInSeconds % 60;

          const gameEndTimestamp = gameData.info.gameEndTimestamp;
          const timeAgo = getTimeAgo(gameEndTimestamp);

          const achievements = [];
          if (participant.pentaKills > 0) achievements.push('Penta Kill');
          if (participant.quadraKills > 0) achievements.push('Quadra Kill');
          if (participant.tripleKills > 0) achievements.push('Triple Kill');
          if (participant.doubleKills > 0) achievements.push('Double Kill');

          const badges = [];
          if (participant.challenges?.teamDamagePercentage > 0.35)
            badges.push('MVP');
          if (participant.challenges?.killParticipation > 0.65)
            badges.push('Unstoppable');
          if (participant.challenges?.perfectGame) badges.push('Perfect');
          if (participant.largestMultiKill >= 2)
            badges.push(getMultiKillBadge(participant.largestMultiKill));

          return {
            gameId: gameData.metadata.matchId,
            queueType: 'Ranked Solo/Duo',
            timeAgo,
            result: participant.win ? 'Victory' : 'Defeat',
            duration: {
              minutes,
              seconds,
            },
            champion: {
              id: participant.championId,
              name: participant.championName,
              level: participant.champLevel,
            },
            kda: {
              kills: participant.kills,
              deaths: participant.deaths,
              assists: participant.assists,
              ratio: (
                (participant.kills + participant.assists) /
                Math.max(participant.deaths, 1)
              ).toFixed(2),
              perfect: participant.deaths === 0,
            },
            cs: {
              total:
                participant.totalMinionsKilled +
                participant.neutralMinionsKilled,
              perMinute: (
                (participant.totalMinionsKilled +
                  participant.neutralMinionsKilled) /
                (durationInSeconds / 60)
              ).toFixed(1),
            },
            runes: {
              primaryRune: participant.perks.styles[0].selections[0].perk,
              secondaryPath: participant.perks.styles[1].style,
            },
            spells: [participant.summoner1Id, participant.summoner2Id],
            items: [
              participant.item0,
              participant.item1,
              participant.item2,
              participant.item3,
              participant.item4,
              participant.item5,
              participant.item6,
            ],
            vision: {
              score: participant.visionScore,
              wards: participant.wardsPlaced,
            },
            achievements,
            badges,
            gameStats: {
              position: participant.teamPosition || 'NONE',
              damageDealt: participant.totalDamageDealtToChampions,
              damageTaken: participant.totalDamageTaken,
              goldEarned: participant.goldEarned,
              killParticipation: participant.challenges?.killParticipation || 0,
            },
            teams: {
              ally: gameData.info.participants
                .filter(p => p.teamId === participant.teamId)
                .map(p => ({
                  summonerName: p.summonerName,
                  champion: p.championName,
                })),
              enemy: gameData.info.participants
                .filter(p => p.teamId !== participant.teamId)
                .map(p => ({
                  summonerName: p.summonerName,
                  champion: p.championName,
                })),
            },
          };
        });
      },
    );

    res.json(matchHistory);
  } catch (error) {
    console.error('Error details:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: error.message });
  }
});

function getTimeAgo(timestamp) {
  const now = Date.now();
  const diffInSeconds = Math.floor((now - timestamp) / 1000);

  if (diffInSeconds < 60) return `${diffInSeconds} seconds ago`;
  if (diffInSeconds < 3600)
    return `${Math.floor(diffInSeconds / 60)} minutes ago`;
  if (diffInSeconds < 86400)
    return `${Math.floor(diffInSeconds / 3600)} hours ago`;
  return `${Math.floor(diffInSeconds / 86400)} days ago`;
}

function getMultiKillBadge(kills) {
  switch (kills) {
    case 2:
      return 'Double Kill';
    case 3:
      return 'Triple Kill';
    case 4:
      return 'Quadra Kill';
    case 5:
      return 'Penta Kill';
    default:
      return '';
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT} in ${
      process.env.NODE_ENV || 'development'
    } mode`,
  );
});
