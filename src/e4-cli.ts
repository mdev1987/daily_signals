/**
 * E4 Evaluation CLI
 * 
 * Runs the multi-timeframe state evaluation (Phase 2) as specified in the roadmap.
 */

import { DATABASE_PATH, openDatabase } from "./database";
import { runE4Evaluation } from "./e4-evaluation";

async function main(): Promise<void> {
  console.log("==================================");
  console.log(" Phase 2: E4 Multi-Timeframe State Evaluation");
  console.log(" Live Daily Signals Project");
  console.log("==================================");
  console.log(` Database: ${DATABASE_PATH}`);
  console.log("==================================");
  
  const connection = await openDatabase();
  
  try {
    const results = await runE4Evaluation(connection, ["1h", "4h", "1d"]);
    
    console.log("\n==================================");
    console.log(" E4 EVALUATION SUMMARY");
    console.log("==================================");
    
    for (const result of results) {
      console.log(`\n--- Main Timeframe: ${result.mainTimeframe} ---`);
      console.log(`Total Positions: ${result.totalPositions}`);
      console.log(`State Transitions: ${result.stateTransitions.length}`);
      console.log(`Forward Return Samples: ${result.forwardReturns.length}`);
      
      console.log("\nState Statistics:");
      for (const [state, stats] of Object.entries(result.stateStats)) {
        console.log(`  ${state}:`);
        console.log(`    Count: ${stats.count}`);
        console.log(`    Mean Return: ${(stats.meanReturn * 100).toFixed(4)}%`);
        console.log(`    Median Return: ${(stats.medianReturn * 100).toFixed(4)}%`);
        console.log(`    Hit Rate: ${(stats.hitRate * 100).toFixed(2)}%`);
        console.log(`    MFE Mean: ${(stats.mfeMean * 100).toFixed(4)}%`);
        console.log(`    MAE Mean: ${(stats.maeMean * 100).toFixed(4)}%`);
      }
    }
    
    console.log("\n==================================");
    console.log(" Phase 2 Complete");
    console.log("==================================");
    
  } catch (error) {
    console.error("Error during E4 evaluation:", error);
    process.exit(1);
  } finally {
    connection.disconnectSync();
  }
}

await main();