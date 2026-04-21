library(ggplot2)
(ggplot(plot_df)
  + geom_point(aes(x = x, y = y))
  + theme_bw())
