declare module "snowball-stemmers" {
  export interface Stemmer {
    stem(value: string): string;
  }

  export interface SnowballFactory {
    newStemmer(language: string): Stemmer;
    algorithms(): string[];
  }

  const snowballFactory: SnowballFactory;
  export default snowballFactory;
}
