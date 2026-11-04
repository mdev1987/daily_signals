/**
 * Phase 1 Statistical Validation CLI
 * 
 * Runs the complete statistical validation of E1 and E2 experiments
 * as specified in the project roadmap.
 */

import { DATABASE_PATH, openDatabase } from "./database";
import { runStatisticalValidation } from "./statistical-validation";

async function main(): Promise<void> {
  console.log("==================================");
  console.log(" Phase 1: Statistical Validation");
  console.log(" Live Daily Signals Project");
  console.log("==================================");
  console.log(` Database: ${DATABASE_PATH}`);
  console.log("==================================");
  
  const connection = await openDatabase();
  
  try {
    const result = await runStatisticalValidation(connection, {
      symbolLevelResampling: true,
      timeBlockResampling: true,
      includeCostAnalysis: true,
    });
    
    // Print summary
    console.log("\n==================================");
    console.log(" STATISTICAL VALIDATION SUMMARY");
    console.log("==================================");
    
    console.log(`
    Total E1 Transitions: ${result.summary.e1TotalTransitions}`);
        console.log(`Total E2 Transitions: ${result.summary.e2TotalTransitions}`);
        console.log(`E1 Fresh Transitions: ${result.summary.e1FreshTransitions}`);
        console.log(`E2 Fresh Transitions: ${result.summary.e2FreshTransitions}`);
        console.log(`E1 Directional Transitions: ${result.summary.e1DirectionalTransitions}`);
        console.log(`E2 Directional Transitions: ${result.summary.e2DirectionalTransitions}`);
        console.log(`E2 Superior to E1: ${result.summary.e2Superior ? "YES" : "NO"}`);
    
    console.log("\n--- Timeframe Analysis ---");
    for (const [timeframe, analysis] of Object.entries(result.timeframeAnalysis)) {
      console.log(`\n${timeframe}:`);
      console.log(`  Total Transitions: ${analysis.totalTransitions}`);
      console.log(`  Fresh Transitions: ${analysis.freshTransitions}`);
      console.log(`  Directional Transitions: ${analysis.directionalTransitions}`);
    }
    
    console.log("\n--- Classification ---");
    console.log(`E1 Classification: ${result.classification.e1Classification}`);
    console.log(`E2 Classification: ${result.classification.e2Classification}`);
    console.log(`Overall Classification: ${result.classification.overallClassification}`);
    
    console.log("\n==================================");
    console.log(" Phase 1 Complete");
    console.log("==================================");
    
  } catch (error) {
    console.error("Error during statistical validation:", error);
    process.exit(1);
  } finally {
    connection.disconnectSync();
  }
}

await main();