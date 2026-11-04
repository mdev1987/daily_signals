# Phase 1: Statistical Validation

This document describes the Phase 1 statistical validation implementation for the Live Daily Signals project.

## Overview

Phase 1 implements the statistical validation of E1 and E2 experiments as specified in the project roadmap. This phase determines whether the signals demonstrate measurable predictive value and whether the five-minute delayed-entry method (E2) performs better than immediate entry (E1).

## Key Objectives

1. **Matched-Event E1 vs E2 Comparison**: Compare E1 and E2 using only transitions eligible for both experiments
2. **Confidence Intervals**: Calculate confidence intervals for returns, hit rates, and performance metrics
3. **Dependence Between Observations**: Account for symbol-level and time-block dependence in statistical analysis
4. **Per-Symbol Analysis**: Assess whether results are broadly distributed or concentrated in specific instruments
5. **Weekday and Trading-Session Analysis**: Investigate performance variations across different market conditions
6. **Transaction Costs and Slippage**: Evaluate profitability after realistic execution costs
7. **Final Classification**: Classify each timeframe/signal combination and provide overall recommendations

## Implementation Details

### Core Components

#### 1. Statistical Validation Engine (`src/statistical-validation.ts`)

The main statistical validation module orchestrates the complete Phase 1 analysis:

- Evaluates all supported timeframes (5m, 15m, 30m, 1h, 4h, 1d)
- Performs matched-event comparison between E1 and E2
- Calculates confidence intervals using bootstrap methods
- Implements symbol-level and time-block resampling
- Conducts per-symbol concentration analysis
- Analyzes weekday and trading session performance
- Models transaction costs and slippage scenarios
- Produces final classifications for each timeframe/signal combination

#### 2. CLI Interface (`src/validate.ts`)

Provides a command-line interface for running the statistical validation:

```bash
bun run validate
```

The CLI prints a comprehensive summary including:
- Total transitions for E1 and E2
- Fresh and directional transition counts
- Whether E2 demonstrates superiority over E1
- Timeframe-specific analysis
- Final classifications

### Key Features

#### Matched-Event Comparison

For each timeframe and signal category, the validation:

1. Identifies transitions eligible for both E1 and E2 experiments
2. Matches events using canonical instrument identity, timeframe, transition timestamp, and signal direction
3. Calculates E1 and E2 entry prices from the same matched events
4. Compares forward returns from identical entry points
5. Records events excluded from either experiment and the reasons

#### Confidence Interval Calculation

For each relevant timeframe and signal category, calculates:

- Mean forward return with confidence intervals
- Median forward return with confidence intervals
- Hit rate with confidence intervals
- E2-minus-E1 return difference with confidence intervals

Uses bootstrap resampling to account for dependence between observations.

#### Dependence Handling

Recognizes that ordinary confidence intervals assuming independent observations may overstate evidence. Implements:

- **Symbol-level resampling**: Resample instruments rather than individual entries
- **Time-block resampling**: Resample contiguous time periods to preserve temporal dependence

#### Per-Symbol Analysis

For each timeframe and signal category, calculates:

- Number of entries per symbol
- Mean, median, and hit rate per symbol
- MFE and MAE per symbol
- Contribution to aggregate return
- Aggregate result after excluding top contributors

#### Weekday and Session Analysis

Analyzes performance by:

- Monday through Friday
- Relevant trading sessions (instrument-aware)
- Identifies whether signal performance changes depending on time of week or trading session

#### Cost Sensitivity Analysis

Evaluates three scenarios:

| Scenario | Assumptions |
|----------|-------------|
| Baseline | Zero transaction cost and slippage |
| Moderate | Reasonable estimated execution costs |
| Stress | Higher costs and adverse slippage |

### Data Requirements

The statistical validation requires:

1. **Complete historical signal data** across all timeframes
2. **Corresponding price candle data** for alignment
3. **Canonical symbol mappings** for accurate instrument identification
4. **Signal snapshot data** with proper timestamps

All data is read-only; the validation does not modify the database.

## Output Format

### Summary Statistics

```
Total E1 Transitions: 4,643
Total E2 Transitions: 3,964
E1 Fresh Transitions: 4,643
E2 Fresh Transitions: 3,964
E1 Directional Transitions: 4,643
E2 Directional Transitions: 3,964
E2 Superior to E1: YES
```

### Timeframe Analysis

Detailed breakdown by timeframe showing:
- Total transitions
- Fresh transitions
- Directional transitions
- E1 and E2 entry counts

### Classification

Each timeframe/signal combination is classified as:

| Classification | Meaning |
|---------------|---------|
| Promising | Positive results with reasonable sample size and robustness |
| Inconclusive | Potentially positive, but insufficient statistical evidence |
| No Demonstrated Edge | No meaningful positive result established |
| Negative | Consistently unfavorable results |

### Cost Analysis

Results for baseline, moderate, and stress cost scenarios showing:
- Gross and net returns
- Impact of transaction costs and slippage
- Whether observed predictive advantage survives realistic execution assumptions

## Usage

### Running the Validation

```bash
# From the project root directory
bun run validate
```

### Dependencies

The validation requires the same dependencies as the main application:

- `@duckdb/node-api`: Database operations
- `bun`: Runtime and package manager
- TypeScript: Type checking

### Database Setup

The validation connects to the DuckDB database at `./data/signals.duckdb`. Ensure:

1. The database has been populated with signal data
2. Price candle data is available for all timeframes
3. Canonical symbol mappings are correctly applied

## Integration with Project Roadmap

Phase 1 is the current priority and must be completed before proceeding to:

- **Phase 2**: E4 multi-timeframe state evaluation
- **Phase 3**: E3 price-based confirmation (deferred pending definition)
- **Phase 4**: Strategy definition and selection
- **Phase 5**: Historical paper backtester
- **Phase 6**: Out-of-sample validation
- **Phase 7**: Live paper trading
- **Phase 8**: Final live-trading decision

## Research Principles Maintained

The statistical validation adheres to all important research principles:

1. **No Look-Ahead Bias**: Only information available at the time of a signal or decision is used
2. **Canonical Symbol Consistency**: All lookups use the same canonical instrument identity
3. **Do Not Treat Every Transition as Independent**: Statistical evaluation accounts for symbol-level and time-level dependence
4. **Incomplete Horizons Are Not Losses**: Coverage and performance are reported separately
5. **Avoid Premature Strategy Optimization**: No parameter optimization or symbol selection based on this dataset
6. **Preserve Experiment Definitions**: E1, E2, and subsequent experiments have explicit definitions
7. **Keep the Architecture Simple**: Uses the existing Bun, TypeScript, and DuckDB architecture

## Deliverables

The Phase 1 statistical validation produces:

1. **Complete E1/E2 statistical report** with all required metrics
2. **Matched-event comparison dataset** for transparent analysis
3. **Confidence intervals and resampling results** for statistical reliability
4. **Per-symbol and time-block breakdowns** for concentration analysis
5. **Weekday and session analysis** for market condition sensitivity
6. **Gross-versus-net cost sensitivity results** for practical profitability assessment
7. **Classification table** for each timeframe and signal
8. **Clear recommendation** about whether E1, E2, both, or neither deserve further strategy development

## Next Steps

After Phase 1 completion:

1. Review the statistical validation results
2. Decide whether to proceed with E4 (multi-timeframe state evaluation)
3. Do not start E4, E3, or the paper backtester in parallel with this assessment
4. Maintain separation between research phases to ensure clear attribution of results

The guiding principle remains:

**Collect reliable data → Validate signal behavior → Test strategy rules → Simulate execution → Validate out of sample → Paper trade → Consider live deployment.**