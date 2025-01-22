import { useEffect, useState } from 'react';

const API_BASE_URL = 'http://localhost:3001';

const App = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchPlayerData = async () => {
      try {
        const region = 'EUW';

        const summonerResponse = await fetch(
          `${API_BASE_URL}/summoner/gameinn/EUW/${region}`,
        );
        const summonerData = await summonerResponse.json();
        console.log('Summoner Data:', summonerData);

        if (summonerData.puuid) {
          const championStatsResponse = await fetch(
            `${API_BASE_URL}/ranked-champions/${summonerData.puuid}/${region}`,
          );
          const championStats = await championStatsResponse.json();
          console.log('Ranked Champion Stats:', championStats);

          const matchHistoryResponse = await fetch(
            `${API_BASE_URL}/match-history/${summonerData.puuid}/${region}/ranked`,
          );
          const matchHistory = await matchHistoryResponse.json();
          console.log('Match History:', matchHistory);
        }

        setLoading(false);
      } catch (err) {
        console.error('Error fetching data:', err);
        setError(err.message);
        setLoading(false);
      }
    };

    fetchPlayerData();
  }, []);

  return (
    <div className='p-4'>
      <h1 className='text-2xl font-bold mb-4'>League Stats Tester</h1>
      {loading && <p>Loading data... Check console for results</p>}
      {error && <p className='text-red-500'>Error: {error}</p>}
      {!loading && !error && (
        <p>Data fetched successfully! Check the console for results.</p>
      )}
    </div>
  );
};

export default App;
