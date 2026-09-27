#!/usr/bin/env node
/**
 * Version bumping script based on conventional commit messages
 * Supports:
 * - feat: -> minor version bump
 * - fix: -> patch version bump
 * - release: -> patch version bump
 * - BREAKING CHANGE: -> major version bump
 */

const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const path = require('path');

// Get the latest commit message
let commitMessage;
try {
  commitMessage = execSync('git log --format=%s -n 1 HEAD', { encoding: 'utf8' }).trim();
} catch (error) {
  // If no commits yet (initial commit), default to patch
  commitMessage = 'initial commit';
}

console.log(`Latest commit message: "${commitMessage}"`);

// Determine version bump type
let bumpType = 'patch'; // default

if (commitMessage.startsWith('feat:')) {
  bumpType = 'minor';
} else if (commitMessage.startsWith('fix:')) {
  bumpType = 'patch';
} else if (commitMessage.startsWith('release:')) {
  bumpType = 'patch';
} else if (commitMessage.includes('BREAKING CHANGE:')) {
  bumpType = 'major';
}

// Read current package.json
const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const currentVersion = packageJson.version;

console.log(`Current version: ${currentVersion}`);

// Bump version using npm
const result = execSync(`npm version ${bumpType} --no-git-tag-version`, { encoding: 'utf8' });
const newVersion = result.trim();

console.log(`Version bumped: ${currentVersion} → ${newVersion} (${bumpType})`);

// Stage the updated package.json
execSync('git add package.json');

console.log('✅ Version bumped and staged for commit');