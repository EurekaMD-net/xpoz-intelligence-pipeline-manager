/**
 * Quick test: single subreddit fetch to validate the parser
 */
import { getSubredditPosts } from "./ingest/xpoz-client.js";

const posts = await getSubredditPosts("immortalists");
console.log("Posts received:", posts.length);
if (posts.length > 0) {
  console.log("\nSample post:");
  console.log(JSON.stringify(posts[0], null, 2));
  const scores = posts.map((p) => p.score).filter((s) => s > 0);
  if (scores.length > 0) {
    console.log(`\nScore range: ${Math.min(...scores)} - ${Math.max(...scores)}`);
    console.log(`Posts with score > 0: ${scores.length}/${posts.length}`);
  }
} else {
  console.log("No posts returned — check parser.");
}
